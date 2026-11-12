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
import { PermissionsService } from '@/common/services/permissions.service.js';
import { hash } from '@/common/utils/hash.util.js';
import type { S3Service } from '@/core/storage/s3.service.js';
import type { PrismaClient } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { UpdateUserDto } from '@/modules/users/dto/user.dto.js';
import { UsersService } from '@/modules/users/users.service.js';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import type { AccountEmailQueueService } from '../services/account-email-queue.service.js';
import { EmailVerificationService } from '../services/email-verification.service.js';
import { PasswordResetService } from '../services/password-reset.service.js';
import { UserSecurityTokenService } from '../services/user-security-token.service.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(runDatabaseTests)(
  'Email verification database integration',
  () => {
    let database: IsolatedDatabase;
    let db: PrismaClient;
    let tokens: UserSecurityTokenService;
    let verification: EmailVerificationService;
    let passwordReset: PasswordResetService;
    let users: UsersService;
    let enqueue: ReturnType<typeof vi.fn>;
    let user: { id: string; email: string };

    const tokenRows = () =>
      db.userSecurityToken.findMany({ where: { type: 'EMAIL_VERIFICATION' } });

    /** Issues a token the way registration does and returns what the email carries. */
    const issueToken = async () => {
      await verification.sendTo(user.id);
      const row = await db.userSecurityToken.findFirstOrThrow({
        where: { userId: user.id, type: 'EMAIL_VERIFICATION' },
      });
      return { row, token: tokens.tokenFor('EMAIL_VERIFICATION', row.id) };
    };

    const verify = (token: string) =>
      verification.verify(token, '10.0.0.1', 'agent');

    const storedUser = () =>
      db.user.findUniqueOrThrow({ where: { id: user.id } });

    const profile = (overrides: Record<string, unknown> = {}) =>
      ({
        username: 'alice',
        firstName: 'Alice',
        lastName: 'Doe',
        birthDate: new Date('2000-01-01'),
        email: user.email,
        ...overrides,
      }) as unknown as UpdateUserDto;

    beforeAll(async () => {
      database = await createIsolatedDatabase('email-verification');
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
          username: 'alice',
          firstName: 'Alice',
          lastName: 'Doe',
          birthDate: new Date('2000-01-01'),
          hashedPassword: await hash('the-old-password-123'),
        },
      });
      user = { id: created.id, email: created.email };

      // The isolated host only exposes transactions; the services also read directly.
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
      const logging = new LoggingService(
        { on: vi.fn(), off: vi.fn(), log: vi.fn() } as unknown as Logger,
        config,
      );
      enqueue = vi.fn().mockResolvedValue(true);
      const queue = { enqueue } as unknown as AccountEmailQueueService;
      tokens = new UserSecurityTokenService(config);
      verification = new EmailVerificationService(
        database.prisma,
        tokens,
        queue,
        logging,
      );
      passwordReset = new PasswordResetService(
        database.prisma,
        tokens,
        queue,
        logging,
      );
      users = new UsersService(
        database.prisma,
        { getPublicUrl: () => null } as unknown as S3Service,
        new PermissionsService(database.prisma),
        logging,
        verification,
      );
    });

    afterAll(async () => {
      await database?.dispose();
    });

    describe('a new account', () => {
      it('starts unverified', async () => {
        expect((await storedUser()).emailVerifiedAt).toBeNull();
      });

      it('gets one verification token', async () => {
        await verification.sendTo(user.id);

        expect(await tokenRows()).toMatchObject([
          { userId: user.id, type: 'EMAIL_VERIFICATION', consumedAt: null },
        ]);
      });

      it('stores only the hash of a token derived from the row id', async () => {
        const { row, token } = await issueToken();

        expect(row.tokenHash).toBe(tokens.hash(token));
        expect(JSON.stringify(row)).not.toContain(token);
      });

      it('queues the verification email for that token', async () => {
        const { row } = await issueToken();

        expect(enqueue).toHaveBeenCalledExactlyOnceWith(
          'email-verification',
          row.id,
        );
      });
    });

    describe('verifying', () => {
      it('marks the account as verified', async () => {
        const { token } = await issueToken();

        await verify(token);

        expect((await storedUser()).emailVerifiedAt).not.toBeNull();
      });

      it('marks the token as used', async () => {
        const { row, token } = await issueToken();

        await verify(token);

        expect(
          (
            await db.userSecurityToken.findUniqueOrThrow({
              where: { id: row.id },
            })
          ).consumedAt,
        ).not.toBeNull();
      });

      it('records the verification in the audit log without the address or token', async () => {
        const { token } = await issueToken();

        await verify(token);

        const event = await db.auditEvent.findFirstOrThrow({
          where: { action: 'user.email.verified' },
        });
        expect(event).toMatchObject({
          actorType: 'ANONYMOUS',
          actorId: null,
          targetId: user.id,
          targetType: 'USER',
          payload: { method: 'EMAIL_LINK' },
        });
        expect(JSON.stringify(event)).not.toContain(token);
        expect(JSON.stringify(event)).not.toContain(user.email);
      });

      it('refuses the same link a second time', async () => {
        const { token } = await issueToken();
        await verify(token);

        await expect(verify(token)).rejects.toMatchObject({
          status: 400,
          message: 'Invalid or expired token',
        });
      });
    });

    describe('a token that cannot be used', () => {
      it('is refused when it has expired', async () => {
        const { row, token } = await issueToken();
        await db.userSecurityToken.update({
          where: { id: row.id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });

        await expect(verify(token)).rejects.toMatchObject({ status: 400 });
      });

      it('leaves the account unverified when it has expired', async () => {
        const { row, token } = await issueToken();
        await db.userSecurityToken.update({
          where: { id: row.id },
          data: { expiresAt: new Date(Date.now() - 1_000) },
        });

        await verify(token).catch(() => undefined);

        expect((await storedUser()).emailVerifiedAt).toBeNull();
      });

      it('is refused when it was never issued', async () => {
        await expect(verify('A'.repeat(43))).rejects.toMatchObject({
          status: 400,
          message: 'Invalid or expired token',
        });
      });

      it('writes no audit event when it is refused', async () => {
        await verify('A'.repeat(43)).catch(() => undefined);

        await expect(db.auditEvent.count()).resolves.toBe(0);
      });

      it('is refused when the account was deleted after the email was sent', async () => {
        const { token } = await issueToken();
        await db.user.update({
          where: { id: user.id },
          data: { deletedAt: new Date() },
        });

        await expect(verify(token)).rejects.toMatchObject({ status: 400 });
      });

      it('cannot be a password reset token', async () => {
        await passwordReset.requestReset(user.email);
        const reset = await db.userSecurityToken.findFirstOrThrow({
          where: { userId: user.id, type: 'PASSWORD_RESET' },
        });

        await expect(
          verify(tokens.tokenFor('PASSWORD_RESET', reset.id)),
        ).rejects.toMatchObject({ status: 400 });
      });

      it('does not verify the account when it is a password reset token', async () => {
        await passwordReset.requestReset(user.email);
        const reset = await db.userSecurityToken.findFirstOrThrow({
          where: { userId: user.id, type: 'PASSWORD_RESET' },
        });

        await verify(tokens.tokenFor('PASSWORD_RESET', reset.id)).catch(
          () => undefined,
        );

        expect((await storedUser()).emailVerifiedAt).toBeNull();
      });

      it('cannot reset a password when it is a verification token', async () => {
        const { token } = await issueToken();

        await expect(
          passwordReset.resetPassword(token, 'a-brand-new-password'),
        ).rejects.toMatchObject({ status: 400 });
      });
    });

    describe('two verifications with the same token at once', () => {
      const runBoth = async () => {
        const { token } = await issueToken();
        return Promise.allSettled([verify(token), verify(token)]);
      };

      it('lets exactly one succeed', async () => {
        const results = await runBoth();

        expect(
          results.filter(({ status }) => status === 'fulfilled'),
        ).toHaveLength(1);
      });

      it('writes a single audit event', async () => {
        await runBoth();

        await expect(
          db.auditEvent.count({ where: { action: 'user.email.verified' } }),
        ).resolves.toBe(1);
      });
    });

    describe('asking for another link', () => {
      it('replaces the earlier token', async () => {
        const first = await issueToken();

        await verification.resend(user.id);

        const rows = await tokenRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].id).not.toBe(first.row.id);
      });

      it('makes the earlier link stop working', async () => {
        const first = await issueToken();
        await verification.resend(user.id);

        await expect(verify(first.token)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('queues a new email', async () => {
        await issueToken();
        enqueue.mockClear();

        await verification.resend(user.id);

        expect(enqueue).toHaveBeenCalledOnce();
      });

      it('does nothing once the account is verified', async () => {
        await db.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: new Date() },
        });

        await verification.resend(user.id);

        expect(await tokenRows()).toEqual([]);
      });
    });

    describe('changing the email', () => {
      const verifyAccount = () =>
        db.user.update({
          where: { id: user.id },
          data: { emailVerifiedAt: new Date() },
        });

      it('makes a verified account unverified', async () => {
        await verifyAccount();

        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );

        expect((await storedUser()).emailVerifiedAt).toBeNull();
      });

      it('issues a token for the new address', async () => {
        await verifyAccount();

        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );

        expect(await tokenRows()).toMatchObject([{ userId: user.id }]);
      });

      it('queues the verification email for that token', async () => {
        await verifyAccount();

        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );

        const [row] = await tokenRows();
        expect(enqueue).toHaveBeenCalledExactlyOnceWith(
          'email-verification',
          row.id,
        );
      });

      it('stops the link sent to the old address from verifying the new one', async () => {
        const oldLink = await issueToken();

        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );

        await expect(verify(oldLink.token)).rejects.toMatchObject({
          status: 400,
        });
      });

      it('keeps the account unverified after the old link is tried', async () => {
        const oldLink = await issueToken();
        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );

        await verify(oldLink.token).catch(() => undefined);

        expect((await storedUser()).emailVerifiedAt).toBeNull();
      });

      it('lets the link sent to the new address verify it', async () => {
        await verifyAccount();
        await users.update(
          user.id,
          profile({ email: `new-${randomUUID()}@example.com` }),
        );
        const [row] = await tokenRows();

        await verify(tokens.tokenFor('EMAIL_VERIFICATION', row.id));

        expect((await storedUser()).emailVerifiedAt).not.toBeNull();
      });

      it('leaves a verified account verified when the email is unchanged', async () => {
        await verifyAccount();

        await users.update(user.id, profile({ firstName: 'Alicia' }));

        expect((await storedUser()).emailVerifiedAt).not.toBeNull();
      });

      it('issues no token when the email is unchanged', async () => {
        await verifyAccount();

        await users.update(user.id, profile({ firstName: 'Alicia' }));

        expect(await tokenRows()).toEqual([]);
      });
    });
  },
);
