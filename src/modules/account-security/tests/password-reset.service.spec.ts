import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import {
  FORGOT_PASSWORD_MIN_DURATION_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
} from '../constants/account-security.constant.js';
import type { AccountEmailQueueService } from '../services/account-email-queue.service.js';
import { PasswordResetService } from '../services/password-reset.service.js';
import type { UserSecurityTokenService } from '../services/user-security-token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));
vi.mock('@/common/utils/hash.util.js', () => ({
  hash: vi.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
}));

const USER_ID = '123e4567-e89b-42d3-a456-426614174002';
const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';
const TOKEN = 'T'.repeat(43);
const TOKEN_HASH = 'hash-of-the-token';
const NEW_PASSWORD = 'a-brand-new-password';
const NOW = new Date('2026-06-15T12:00:00Z');

const usable = (overrides: Record<string, unknown> = {}) => ({
  type: 'PASSWORD_RESET',
  consumedAt: null,
  expiresAt: new Date(NOW.getTime() + 60_000),
  user: { deletedAt: null },
  ...overrides,
});

function setup() {
  const manager = {
    userSecurityToken: {
      findUnique: vi.fn().mockResolvedValue({ id: ROW_ID, userId: USER_ID }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
  };
  const serializableTransaction = vi.fn(
    (operation: (client: unknown) => Promise<unknown>) => operation(manager),
  );
  const prisma = {
    serializableTransaction,
    user: { findUnique: vi.fn().mockResolvedValue({ id: USER_ID }) },
    userSecurityToken: { findUnique: vi.fn().mockResolvedValue(usable()) },
  };
  const tokens = {
    issue: vi.fn().mockResolvedValue({ id: ROW_ID, expiresAt: NOW }),
    hash: vi.fn().mockReturnValue(TOKEN_HASH),
  };
  const emailQueue = { enqueuePasswordReset: vi.fn().mockResolvedValue(true) };
  const auditEvent = { eventId: 'event-1' };
  const logging = {
    security: vi.fn(),
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new PasswordResetService(
    prisma as unknown as PrismaService,
    tokens as unknown as UserSecurityTokenService,
    emailQueue as unknown as AccountEmailQueueService,
    logging as unknown as LoggingService,
  );
  return {
    service,
    manager,
    prisma,
    serializableTransaction,
    tokens,
    emailQueue,
    logging,
    auditEvent,
  };
}

describe('PasswordResetService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('requestReset', () => {
    const run = async (service: PasswordResetService, email: string) => {
      const request = service.requestReset(email, '10.0.0.1', 'agent');
      await vi.advanceTimersByTimeAsync(FORGOT_PASSWORD_MIN_DURATION_MS);
      await request;
    };

    it('looks the account up by its normalized, active address', async () => {
      const { service, prisma } = setup();

      await run(service, '  Alice@Example.COM ');

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'alice@example.com', deletedAt: null },
        select: { id: true },
      });
    });

    describe('for an address without an account', () => {
      it('issues no token', async () => {
        const { service, prisma, tokens } = setup();
        prisma.user.findUnique.mockResolvedValue(null);

        await run(service, 'nobody@example.com');

        expect(tokens.issue).not.toHaveBeenCalled();
      });

      it('sends nothing', async () => {
        const { service, prisma, emailQueue } = setup();
        prisma.user.findUnique.mockResolvedValue(null);

        await run(service, 'nobody@example.com');

        expect(emailQueue.enqueuePasswordReset).not.toHaveBeenCalled();
      });

      it('records no security event', async () => {
        const { service, prisma, logging } = setup();
        prisma.user.findUnique.mockResolvedValue(null);

        await run(service, 'nobody@example.com');

        expect(logging.security).not.toHaveBeenCalled();
      });
    });

    describe('for a registered address', () => {
      it('issues a token for that account with the reset lifetime', async () => {
        const { service, manager, tokens } = setup();

        await run(service, 'alice@example.com');

        expect(tokens.issue).toHaveBeenCalledWith(
          manager,
          USER_ID,
          'PASSWORD_RESET',
          PASSWORD_RESET_TOKEN_LIFETIME_MS,
        );
      });

      it('records the request without the address', async () => {
        const { service, logging } = setup();

        await run(service, 'alice@example.com');

        expect(logging.security).toHaveBeenCalledExactlyOnceWith({
          action: 'auth.password_reset.requested',
          actor: { type: 'ANONYMOUS' },
          target: { type: 'USER', id: USER_ID },
          requestContext: expect.objectContaining({
            sourceIp: '10.0.0.1',
            userAgent: 'agent',
          }),
        });
      });

      it('queues the email for the new token', async () => {
        const { service, emailQueue } = setup();

        await run(service, 'alice@example.com');

        expect(emailQueue.enqueuePasswordReset).toHaveBeenCalledExactlyOnceWith(
          ROW_ID,
        );
      });

      it('queues the email only after the transaction', async () => {
        const { service, serializableTransaction, emailQueue } = setup();

        await run(service, 'alice@example.com');

        expect(
          serializableTransaction.mock.invocationCallOrder[0],
        ).toBeLessThan(
          emailQueue.enqueuePasswordReset.mock.invocationCallOrder[0],
        );
      });

      it('does not queue an email when the token cannot be saved', async () => {
        const { service, tokens, emailQueue } = setup();
        tokens.issue.mockRejectedValue(new Error('database down'));

        const request = service.requestReset('alice@example.com');
        const outcome = request.catch(() => undefined);
        await vi.advanceTimersByTimeAsync(FORGOT_PASSWORD_MIN_DURATION_MS);
        await outcome;

        expect(emailQueue.enqueuePasswordReset).not.toHaveBeenCalled();
      });

      it('succeeds even when the queue refuses the job', async () => {
        const { service, emailQueue } = setup();
        emailQueue.enqueuePasswordReset.mockResolvedValue(false);

        await expect(
          run(service, 'alice@example.com'),
        ).resolves.toBeUndefined();
      });
    });

    describe('timing', () => {
      it.each([
        ['an unknown address', null],
        ['a registered address', { id: USER_ID }],
      ])('takes the minimum duration for %s', async (_, user) => {
        const { service, prisma } = setup();
        prisma.user.findUnique.mockResolvedValue(user);
        let finished = false;

        const request = service
          .requestReset('alice@example.com')
          .then(() => (finished = true));
        await vi.advanceTimersByTimeAsync(FORGOT_PASSWORD_MIN_DURATION_MS - 1);
        const finishedEarly = finished;
        await vi.advanceTimersByTimeAsync(1);
        await request;

        expect(finishedEarly).toBe(false);
      });

      it('still takes the minimum duration when it fails', async () => {
        const { service, prisma } = setup();
        prisma.user.findUnique.mockRejectedValue(new Error('database down'));
        let settled = false;

        const request = service
          .requestReset('alice@example.com')
          .catch(() => undefined)
          .then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(FORGOT_PASSWORD_MIN_DURATION_MS - 1);
        const settledEarly = settled;
        await vi.advanceTimersByTimeAsync(1);
        await request;

        expect(settledEarly).toBe(false);
      });

      it('passes a failure on to the caller', async () => {
        const { service, prisma } = setup();
        prisma.user.findUnique.mockRejectedValue(new Error('database down'));

        const request = service.requestReset('alice@example.com');
        const assertion = expect(request).rejects.toThrow('database down');
        await vi.advanceTimersByTimeAsync(FORGOT_PASSWORD_MIN_DURATION_MS);

        await assertion;
      });
    });
  });

  describe('resetPassword', () => {
    const reset = (service: PasswordResetService) =>
      service.resetPassword(TOKEN, NEW_PASSWORD, '10.0.0.1', 'agent');

    describe('with a token that cannot be used', () => {
      it.each([
        ['unknown', null],
        ['already used', usable({ consumedAt: new Date() })],
        ['expired', usable({ expiresAt: new Date(NOW.getTime() - 1) })],
        ['expiring right now', usable({ expiresAt: NOW })],
        ['of a deleted account', usable({ user: { deletedAt: new Date() } })],
        ['of another type', usable({ type: 'SOME_OTHER_TYPE' })],
      ])(
        'rejects a token that is %s with one generic error',
        async (_, row) => {
          const { service, prisma } = setup();
          prisma.userSecurityToken.findUnique.mockResolvedValue(row);

          await expect(reset(service)).rejects.toMatchObject({
            status: 400,
            message: 'Invalid or expired token',
          });
        },
      );

      it('does not spend a password hash on it', async () => {
        const { service, prisma } = setup();
        const { hash } = await import('@/common/utils/hash.util.js');
        vi.mocked(hash).mockClear();
        prisma.userSecurityToken.findUnique.mockResolvedValue(null);

        await reset(service).catch(() => undefined);

        expect(hash).not.toHaveBeenCalled();
      });

      it('changes nothing', async () => {
        const { service, prisma, serializableTransaction } = setup();
        prisma.userSecurityToken.findUnique.mockResolvedValue(null);

        await reset(service).catch(() => undefined);

        expect(serializableTransaction).not.toHaveBeenCalled();
      });

      it('records the rejection', async () => {
        const { service, prisma, logging } = setup();
        prisma.userSecurityToken.findUnique.mockResolvedValue(null);

        await reset(service).catch(() => undefined);

        expect(logging.security).toHaveBeenCalledExactlyOnceWith({
          action: 'auth.password_reset.failed',
          actor: { type: 'ANONYMOUS' },
          reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
          requestContext: expect.objectContaining({ sourceIp: '10.0.0.1' }),
        });
      });

      it('keeps the token out of that record', async () => {
        const { service, prisma, logging } = setup();
        prisma.userSecurityToken.findUnique.mockResolvedValue(null);

        await reset(service).catch(() => undefined);

        expect(JSON.stringify(logging.security.mock.calls)).not.toContain(
          TOKEN,
        );
      });
    });

    describe('with a usable token', () => {
      it('looks the token up by its hash', async () => {
        const { service, prisma } = setup();

        await reset(service);

        expect(prisma.userSecurityToken.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { tokenHash: TOKEN_HASH } }),
        );
      });

      it('uses the token up only if it is still unused and unexpired', async () => {
        const { service, manager } = setup();

        await reset(service);

        expect(manager.userSecurityToken.updateMany).toHaveBeenCalledWith({
          where: {
            id: ROW_ID,
            type: 'PASSWORD_RESET',
            consumedAt: null,
            expiresAt: { gt: NOW },
          },
          data: { consumedAt: NOW },
        });
      });

      it('stores the hash of the new password for that active account', async () => {
        const { service, manager } = setup();

        await reset(service);

        expect(manager.user.updateMany).toHaveBeenCalledWith({
          where: { id: USER_ID, deletedAt: null },
          data: { hashedPassword: `hashed:${NEW_PASSWORD}` },
        });
      });

      it('revokes every refresh session of the account', async () => {
        const { service, manager } = setup();

        await reset(service);

        expect(manager.refreshToken.updateMany).toHaveBeenCalledWith({
          where: { userId: USER_ID, revokedAt: null },
          data: { revokedAt: NOW },
        });
      });

      it('audits the reset with the number of revoked sessions', async () => {
        const { service, logging, manager } = setup();

        await reset(service);

        expect(logging.audit).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'user.password.reset',
            actor: { type: 'ANONYMOUS' },
            target: { type: 'USER', id: USER_ID },
            payload: { revokedRefreshTokenCount: 2 },
          }),
          manager,
        );
      });

      it('publishes the audit copy of the stored event', async () => {
        const { service, logging, auditEvent } = setup();

        await reset(service);

        expect(logging.publishCommittedAudit).toHaveBeenCalledExactlyOnceWith(
          auditEvent,
        );
      });

      it('publishes it only after the transaction', async () => {
        const { service, serializableTransaction, logging } = setup();

        await reset(service);

        expect(
          serializableTransaction.mock.invocationCallOrder[0],
        ).toBeLessThan(
          logging.publishCommittedAudit.mock.invocationCallOrder[0],
        );
      });

      it('records no rejection', async () => {
        const { service, logging } = setup();

        await reset(service);

        expect(logging.security).not.toHaveBeenCalled();
      });
    });

    describe('when the token is lost between the check and the change', () => {
      it.each([
        [
          'another reset used it first',
          (ctx: ReturnType<typeof setup>) =>
            ctx.manager.userSecurityToken.updateMany.mockResolvedValue({
              count: 0,
            }),
        ],
        [
          'its row is gone',
          (ctx: ReturnType<typeof setup>) =>
            ctx.manager.userSecurityToken.findUnique.mockResolvedValue(null),
        ],
        [
          'the account was deleted',
          (ctx: ReturnType<typeof setup>) =>
            ctx.manager.user.updateMany.mockResolvedValue({ count: 0 }),
        ],
      ])('rejects it as generic when %s', async (_, lose) => {
        const ctx = setup();
        lose(ctx);

        await expect(reset(ctx.service)).rejects.toMatchObject({
          status: 400,
          message: 'Invalid or expired token',
        });
      });

      it('records the rejection', async () => {
        const ctx = setup();
        ctx.manager.userSecurityToken.updateMany.mockResolvedValue({
          count: 0,
        });

        await reset(ctx.service).catch(() => undefined);

        expect(ctx.logging.security).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'auth.password_reset.failed' }),
        );
      });

      it('publishes no audit copy', async () => {
        const ctx = setup();
        ctx.manager.userSecurityToken.updateMany.mockResolvedValue({
          count: 0,
        });

        await reset(ctx.service).catch(() => undefined);

        expect(ctx.logging.publishCommittedAudit).not.toHaveBeenCalled();
      });

      it('does not revoke sessions when the account is gone', async () => {
        const ctx = setup();
        ctx.manager.user.updateMany.mockResolvedValue({ count: 0 });

        await reset(ctx.service).catch(() => undefined);

        expect(ctx.manager.refreshToken.updateMany).not.toHaveBeenCalled();
      });
    });

    it('passes on an unexpected failure without calling it a bad token', async () => {
      const ctx = setup();
      ctx.manager.user.updateMany.mockRejectedValue(new Error('database down'));

      await expect(reset(ctx.service)).rejects.toThrow('database down');
    });
  });
});
