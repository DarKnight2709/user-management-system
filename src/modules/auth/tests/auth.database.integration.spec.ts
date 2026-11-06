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
import { hash } from '@/common/utils/hash.util.js';
import type { PrismaClient } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  clearOrganizationTables,
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import { AuthSessionService } from '../services/auth-session.service.js';
import { PasswordService } from '../services/password.service.js';
import { TokenService } from '../services/token.service.js';
import type { ChangePasswordDto } from '../dto/change-password.dto.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const CURRENT_PASSWORD = 'current-password-123';
const NEW_PASSWORD = 'brand-new-password-456';

describe.runIf(runDatabaseTests)('Auth database integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let sessions: AuthSessionService;
  let passwords: PasswordService;
  let tokens: TokenService;
  let securityLog: ReturnType<typeof vi.fn>;
  let user: { id: string; username: string; email: string };

  const activeTokens = (userId = user.id) =>
    db.refreshToken.count({ where: { userId, revokedAt: null } });

  const login = () => sessions.login(user, '10.0.0.1', 'agent');

  const tokenRow = (token: string) =>
    db.refreshToken.findUniqueOrThrow({
      where: { id: tokens.verifyRefreshToken(token).jti },
    });

  const change = (current = CURRENT_PASSWORD, next = NEW_PASSWORD) =>
    passwords.changePassword(user.id, {
      currentPassword: current,
      newPassword: next,
    } as ChangePasswordDto);

  beforeAll(async () => {
    database = await createIsolatedDatabase('auth');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await db.auditEvent.deleteMany();
    await db.refreshToken.deleteMany();
    await clearOrganizationTables(db);
    const created = await db.user.create({
      data: {
        email: `alice-${randomUUID()}@example.com`,
        username: `alice-${randomUUID()}`,
        firstName: 'Alice',
        lastName: 'Doe',
        birthDate: new Date('2000-01-01'),
        hashedPassword: await hash(CURRENT_PASSWORD),
      },
    });
    user = { id: created.id, username: created.username, email: created.email };

    // The isolated host only exposes transactions; services also read directly.
    Object.assign(database.prisma, {
      user: db.user,
      refreshToken: db.refreshToken,
    });
    securityLog = vi.fn();
    const logging = new LoggingService(
      { on: vi.fn(), off: vi.fn(), log: securityLog } as unknown as Logger,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    tokens = new TokenService(
      database.prisma,
      new ConfigService({
        JWT_ACCESS_TOKEN_SECRET: 'integration-only-access-secret',
        JWT_ACCESS_TOKEN_EXPIRES_IN: 900,
        JWT_REFRESH_TOKEN_SECRET: 'integration-only-refresh-secret',
        JWT_REFRESH_TOKEN_EXPIRES_IN: 3600,
      }),
    );
    sessions = new AuthSessionService(database.prisma, tokens, logging);
    passwords = new PasswordService(database.prisma, logging);
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe('login', () => {
    it('stores only the hash of the refresh token with client metadata', async () => {
      const { refreshToken } = await login();

      const row = await tokenRow(refreshToken);
      expect(row).toMatchObject({
        userId: user.id,
        refreshTokenHash: tokens.hashToken(refreshToken),
        ipAddress: '10.0.0.1',
        userAgent: 'agent',
        revokedAt: null,
      });
      expect(row.refreshTokenHash).not.toBe(refreshToken);
      expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('starts an independent family per login', async () => {
      const first = await tokenRow((await login()).refreshToken);
      const second = await tokenRow((await login()).refreshToken);

      expect(first.familyId).not.toBe(second.familyId);
    });

    it('refuses deleted accounts and stores no token', async () => {
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await expect(login()).rejects.toMatchObject({ status: 401 });
      await expect(db.refreshToken.count()).resolves.toBe(0);
    });
  });

  describe('refresh token rotation', () => {
    it('revokes the used token and issues a successor in the same family', async () => {
      const { refreshToken } = await login();
      const before = await tokenRow(refreshToken);

      const next = await sessions.refreshToken(refreshToken);

      await expect(tokenRow(refreshToken)).resolves.toMatchObject({
        revokedAt: expect.any(Date),
      });
      const successor = await tokenRow(next.refreshToken);
      expect(successor).toMatchObject({
        familyId: before.familyId,
        revokedAt: null,
      });
      expect(successor.expiresAt.getTime()).toBeLessThanOrEqual(
        before.expiresAt.getTime(),
      );
    });

    it('revokes the whole family when a used token is replayed', async () => {
      const { refreshToken } = await login();
      const next = await sessions.refreshToken(refreshToken);

      await expect(sessions.refreshToken(refreshToken)).rejects.toThrow(
        'Refresh token reuse detected',
      );

      await expect(tokenRow(next.refreshToken)).resolves.toMatchObject({
        revokedAt: expect.any(Date),
      });
      await expect(
        sessions.refreshToken(next.refreshToken),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('leaves other sessions of the same user untouched on reuse', async () => {
      const other = await login();
      const { refreshToken } = await login();
      await sessions.refreshToken(refreshToken);

      await sessions.refreshToken(refreshToken).catch(() => undefined);

      await expect(tokenRow(other.refreshToken)).resolves.toMatchObject({
        revokedAt: null,
      });
    });

    it('rejects tokens of users deleted after login', async () => {
      const { refreshToken } = await login();
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await expect(sessions.refreshToken(refreshToken)).rejects.toMatchObject({
        status: 401,
      });
      await expect(db.refreshToken.count()).resolves.toBe(1);
    });

    it('rejects tokens whose row expired', async () => {
      const { refreshToken } = await login();
      await db.refreshToken.updateMany({
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(sessions.refreshToken(refreshToken)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('rejects a valid signature with no stored row', async () => {
      const { refreshToken } = await login();
      await db.refreshToken.deleteMany();

      await expect(sessions.refreshToken(refreshToken)).rejects.toMatchObject({
        status: 401,
      });
    });

    it('lets exactly one of two simultaneous refreshes win', async () => {
      const { refreshToken } = await login();

      const results = await Promise.allSettled([
        sessions.refreshToken(refreshToken),
        sessions.refreshToken(refreshToken),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected).toMatchObject({ reason: { status: 401 } });
    });
  });

  describe('logout', () => {
    it('revokes only the presented session family', async () => {
      const other = await login();
      const { refreshToken } = await login();

      await sessions.logout(refreshToken, user.id);

      await expect(tokenRow(refreshToken)).resolves.toMatchObject({
        revokedAt: expect.any(Date),
      });
      await expect(tokenRow(other.refreshToken)).resolves.toMatchObject({
        revokedAt: null,
      });
    });

    it('revokes every rotated token of the family', async () => {
      const { refreshToken } = await login();
      const next = await sessions.refreshToken(refreshToken);

      await sessions.logout(next.refreshToken, user.id);

      await expect(activeTokens()).resolves.toBe(0);
    });

    it('refuses another user presenting the token', async () => {
      const { refreshToken } = await login();

      await expect(
        sessions.logout(refreshToken, randomUUID()),
      ).rejects.toMatchObject({ status: 401 });
      await expect(activeTokens()).resolves.toBe(1);
    });

    it('is idempotent for an already revoked family', async () => {
      const { refreshToken } = await login();
      await sessions.logout(refreshToken, user.id);

      await expect(
        sessions.logout(refreshToken, user.id),
      ).resolves.toBeUndefined();
    });

    it('logoutAll revokes every session of that user only', async () => {
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
      await login();
      await login();
      await sessions.login(
        { id: other.id, username: other.username, email: other.email },
        undefined,
        undefined,
      );

      await sessions.logoutAll(user.id);

      await expect(activeTokens()).resolves.toBe(0);
      await expect(activeTokens(other.id)).resolves.toBe(1);
    });
  });

  describe('changePassword', () => {
    it('stores a new hash that verifies and revokes all sessions', async () => {
      await login();
      await login();

      await change();

      const stored = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(stored.hashedPassword).not.toBe(NEW_PASSWORD);
      await expect(activeTokens()).resolves.toBe(0);
      // The new password is now the "current" one; reusing the old fails.
      await expect(change(CURRENT_PASSWORD)).rejects.toMatchObject({
        status: 401,
      });
      await expect(change(NEW_PASSWORD, 'another-password-789')).resolves.toBe(
        undefined,
      );
    });

    it('writes a user.password.changed audit row without secrets', async () => {
      await login();

      await change();

      const rows = await db.auditEvent.findMany({
        where: { action: 'user.password.changed' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorId: user.id,
        targetId: user.id,
        payload: { revokedRefreshTokenCount: 1 },
      });
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain(CURRENT_PASSWORD);
      expect(serialized).not.toContain(NEW_PASSWORD);
    });

    it('changes nothing for a wrong current password', async () => {
      await login();
      const before = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      await expect(change('wrong-password-000')).rejects.toMatchObject({
        status: 401,
      });

      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.hashedPassword).toBe(before.hashedPassword);
      await expect(activeTokens()).resolves.toBe(1);
      await expect(db.auditEvent.count()).resolves.toBe(0);
    });

    it('rejects reusing the current password', async () => {
      await expect(
        change(CURRENT_PASSWORD, CURRENT_PASSWORD),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('rolls back the password and sessions if the audit write fails', async () => {
      await login();
      const failingLogging = {
        audit: vi.fn().mockRejectedValue(new Error('audit down')),
        publishCommittedAudit: vi.fn(),
        security: vi.fn(),
      } as unknown as LoggingService;
      const failing = new PasswordService(database.prisma, failingLogging);
      const before = await db.user.findUniqueOrThrow({
        where: { id: user.id },
      });

      await expect(
        failing.changePassword(user.id, {
          currentPassword: CURRENT_PASSWORD,
          newPassword: NEW_PASSWORD,
        } as ChangePasswordDto),
      ).rejects.toThrow('audit down');

      const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(after.hashedPassword).toBe(before.hashedPassword);
      await expect(activeTokens()).resolves.toBe(1);
    });

    it('lets only one of two simultaneous changes succeed', async () => {
      const results = await Promise.allSettled([
        change(CURRENT_PASSWORD, 'first-new-password-111'),
        change(CURRENT_PASSWORD, 'second-new-password-222'),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await expect(
        db.auditEvent.count({ where: { action: 'user.password.changed' } }),
      ).resolves.toBe(1);
    });

    it('rejects deleted accounts', async () => {
      await db.user.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      await expect(change()).rejects.toMatchObject({ status: 401 });
    });
  });

  it('logs security events through Winston without token or password values', async () => {
    const { refreshToken } = await login();
    await sessions.logout(refreshToken, user.id);
    await change().catch(() => undefined);

    const logged = JSON.stringify(securityLog.mock.calls);
    expect(logged).toContain('auth.login.succeeded');
    expect(logged).not.toContain(refreshToken);
    expect(logged).not.toContain(CURRENT_PASSWORD);
  });
});
