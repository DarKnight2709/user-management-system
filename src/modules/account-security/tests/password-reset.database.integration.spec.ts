import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import { compare, hash } from '@/common/utils/hash.util.js';
import type { PrismaClient } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import {
  FORGOT_PASSWORD_MIN_DURATION_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
} from '../constants/account-security.constant.js';
import type { AccountEmailQueueService } from '../services/account-email-queue.service.js';
import { PasswordResetService } from '../services/password-reset.service.js';
import { UserSecurityTokenService } from '../services/user-security-token.service.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const OLD_PASSWORD = 'the-old-password-123';
const NEW_PASSWORD = 'the-brand-new-password-456';
const OTHER_PASSWORD = 'another-new-password-789';

describe.runIf(runDatabaseTests)('Password reset database integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let service: PasswordResetService;
  let tokens: UserSecurityTokenService;
  let enqueuePasswordReset: ReturnType<typeof vi.fn>;
  let user: { id: string; email: string };

  const tokenRows = () => db.userSecurityToken.findMany();

  /** Requests a reset and returns the token that the email would carry. */
  const requestResetToken = async (email = user.email) => {
    await service.requestReset(email);
    const row = await db.userSecurityToken.findFirstOrThrow({
      where: { user: { email } },
    });
    return { row, token: tokens.tokenFor('PASSWORD_RESET', row.id) };
  };

  const reset = (token: string, password = NEW_PASSWORD) =>
    service.resetPassword(token, password, '10.0.0.1', 'agent');

  const storedHash = async () =>
    (await db.user.findUniqueOrThrow({ where: { id: user.id } }))
      .hashedPassword;

  const createActiveSessions = (count: number) =>
    db.refreshToken.createMany({
      data: Array.from({ length: count }, () => ({
        userId: user.id,
        familyId: randomUUID(),
        refreshTokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      })),
    });

  beforeAll(async () => {
    database = await createIsolatedDatabase('password-reset');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await db.auditEvent.deleteMany();
    await db.refreshToken.deleteMany();
    await db.userSecurityToken.deleteMany();
    await db.user.deleteMany();

    const created = await db.user.create({
      data: {
        email: `alice-${randomUUID()}@example.com`,
        username: `alice-${randomUUID()}`,
        firstName: 'Alice',
        lastName: 'Doe',
        birthDate: new Date('2000-01-01'),
        hashedPassword: await hash(OLD_PASSWORD),
      },
    });
    user = { id: created.id, email: created.email };

    // The isolated host only exposes transactions; the service also reads directly.
    Object.assign(database.prisma, {
      user: db.user,
      userSecurityToken: db.userSecurityToken,
      refreshToken: db.refreshToken,
    });
    const config = new ConfigService({
      NODE_ENV: 'test',
      ACCOUNT_TOKEN_SECRET: 'x'.repeat(64),
      FRONTEND_URL: 'https://app.example.com',
    });
    tokens = new UserSecurityTokenService(config);
    enqueuePasswordReset = vi.fn().mockResolvedValue(true);
    service = new PasswordResetService(
      database.prisma,
      tokens,
      { enqueuePasswordReset } as unknown as AccountEmailQueueService,
      new LoggingService(
        { on: vi.fn(), off: vi.fn(), log: vi.fn() } as unknown as Logger,
        config,
      ),
    );
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe('requesting a reset', () => {
    it('stores one reset token for the account', async () => {
      await service.requestReset(user.email);

      expect(await tokenRows()).toMatchObject([
        { userId: user.id, type: 'PASSWORD_RESET', consumedAt: null },
      ]);
    });

    it('stores the hash of the token, derived from the row id', async () => {
      const { row, token } = await requestResetToken();

      expect(row.tokenHash).toBe(tokens.hash(token));
    });

    it('never stores the token itself', async () => {
      const { row, token } = await requestResetToken();

      expect(JSON.stringify(row)).not.toContain(token);
    });

    it('lets the token expire after the reset lifetime', async () => {
      const before = Date.now();
      const { row } = await requestResetToken();

      expect(row.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
        PASSWORD_RESET_TOKEN_LIFETIME_MS - 1_000,
      );
    });

    it('queues the email for the stored token', async () => {
      const { row } = await requestResetToken();

      expect(enqueuePasswordReset).toHaveBeenCalledExactlyOnceWith(row.id);
    });

    it('replaces the earlier token when asked again', async () => {
      const first = await requestResetToken();
      const second = await requestResetToken();

      expect((await tokenRows()).map(({ id }) => id)).toEqual([second.row.id]);
      expect(second.row.id).not.toBe(first.row.id);
    });

    it('makes the earlier link stop working when asked again', async () => {
      const first = await requestResetToken();
      await requestResetToken();

      await expect(reset(first.token)).rejects.toMatchObject({ status: 400 });
    });

    it('stores nothing for an address without an account', async () => {
      await service.requestReset('nobody@example.com');

      expect(await tokenRows()).toEqual([]);
    });

    it('queues nothing for an address without an account', async () => {
      await service.requestReset('nobody@example.com');

      expect(enqueuePasswordReset).not.toHaveBeenCalled();
    });

    it('stores nothing for a deleted account', async () => {
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await service.requestReset(user.email);

      expect(await tokenRows()).toEqual([]);
    });

    it('takes at least the minimum duration for an unknown address', async () => {
      const startedAt = Date.now();

      await service.requestReset('nobody@example.com');

      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(
        FORGOT_PASSWORD_MIN_DURATION_MS - 50,
      );
    });
  });

  describe('resetting the password', () => {
    it('sets the new password', async () => {
      const { token } = await requestResetToken();

      await reset(token);

      expect(await compare(NEW_PASSWORD, await storedHash())).toBe(true);
    });

    it('stops the old password from working', async () => {
      const { token } = await requestResetToken();

      await reset(token);

      expect(await compare(OLD_PASSWORD, await storedHash())).toBe(false);
    });

    it('revokes every active session of the account', async () => {
      await createActiveSessions(3);
      const { token } = await requestResetToken();

      await reset(token);

      await expect(
        db.refreshToken.count({ where: { userId: user.id, revokedAt: null } }),
      ).resolves.toBe(0);
    });

    it('leaves the sessions of other accounts alone', async () => {
      const other = await db.user.create({
        data: {
          email: `bob-${randomUUID()}@example.com`,
          username: `bob-${randomUUID()}`,
          firstName: 'Bob',
          lastName: 'Doe',
          birthDate: new Date('2000-01-01'),
          hashedPassword: 'fixture',
        },
      });
      await db.refreshToken.create({
        data: {
          userId: other.id,
          familyId: randomUUID(),
          refreshTokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
      const { token } = await requestResetToken();

      await reset(token);

      await expect(
        db.refreshToken.count({ where: { userId: other.id, revokedAt: null } }),
      ).resolves.toBe(1);
    });

    it('marks the token as used', async () => {
      const { row, token } = await requestResetToken();

      await reset(token);

      expect(
        (
          await db.userSecurityToken.findUniqueOrThrow({
            where: { id: row.id },
          })
        ).consumedAt,
      ).not.toBeNull();
    });

    it('records the reset in the audit log with the revoked sessions', async () => {
      await createActiveSessions(2);
      const { token } = await requestResetToken();

      await reset(token);

      expect(
        await db.auditEvent.findFirstOrThrow({
          where: { action: 'user.password.reset' },
        }),
      ).toMatchObject({
        actorType: 'ANONYMOUS',
        actorId: null,
        targetId: user.id,
        targetType: 'USER',
        payload: { revokedRefreshTokenCount: 2 },
      });
    });

    it('keeps the password out of the audit log', async () => {
      const { token } = await requestResetToken();

      await reset(token);

      const events = JSON.stringify(await db.auditEvent.findMany());
      expect(events).not.toContain(NEW_PASSWORD);
      expect(events).not.toContain(token);
    });
  });

  describe('a token that cannot be used', () => {
    it('is refused the second time', async () => {
      const { token } = await requestResetToken();
      await reset(token);

      await expect(reset(token, OTHER_PASSWORD)).rejects.toMatchObject({
        status: 400,
        message: 'Invalid or expired token',
      });
    });

    it('does not change the password the second time', async () => {
      const { token } = await requestResetToken();
      await reset(token);

      await reset(token, OTHER_PASSWORD).catch(() => undefined);

      expect(await compare(NEW_PASSWORD, await storedHash())).toBe(true);
    });

    it('is refused when it has expired', async () => {
      const { row, token } = await requestResetToken();
      await db.userSecurityToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await expect(reset(token)).rejects.toMatchObject({ status: 400 });
    });

    it('leaves the password alone when it has expired', async () => {
      const { row, token } = await requestResetToken();
      await db.userSecurityToken.update({
        where: { id: row.id },
        data: { expiresAt: new Date(Date.now() - 1_000) },
      });

      await reset(token).catch(() => undefined);

      expect(await compare(OLD_PASSWORD, await storedHash())).toBe(true);
    });

    it('is refused when the account was deleted after the request', async () => {
      const { token } = await requestResetToken();
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await expect(reset(token)).rejects.toMatchObject({ status: 400 });
    });

    it('is refused when it was never issued', async () => {
      await expect(reset('A'.repeat(43))).rejects.toMatchObject({
        status: 400,
        message: 'Invalid or expired token',
      });
    });

    it('writes no audit event when it is refused', async () => {
      await reset('A'.repeat(43)).catch(() => undefined);

      await expect(db.auditEvent.count()).resolves.toBe(0);
    });
  });

  describe('two resets with the same token at once', () => {
    const runBoth = async () => {
      const { token } = await requestResetToken();
      const attempts = [NEW_PASSWORD, OTHER_PASSWORD];
      const results = await Promise.allSettled(
        attempts.map((password) => reset(token, password)),
      );
      return { attempts, results };
    };

    it('lets exactly one succeed', async () => {
      const { results } = await runBoth();

      expect(
        results.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
    });

    it('refuses the other as an invalid token', async () => {
      const { results } = await runBoth();

      const rejected = results.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({ reason: { status: 400 } });
    });

    it('keeps the password of the one that succeeded', async () => {
      const { attempts, results } = await runBoth();
      const winner =
        attempts[results.findIndex(({ status }) => status === 'fulfilled')];

      expect(await compare(winner, await storedHash())).toBe(true);
    });

    it('writes a single audit event', async () => {
      await runBoth();

      await expect(
        db.auditEvent.count({ where: { action: 'user.password.reset' } }),
      ).resolves.toBe(1);
    });
  });
});
