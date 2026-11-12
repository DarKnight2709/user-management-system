import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { EMAIL_VERIFICATION_TOKEN_LIFETIME_MS } from '../constants/account-security.constant.js';
import { InvalidSecurityTokenException } from '../invalid-security-token.exception.js';
import type { AccountEmailQueueService } from '../services/account-email-queue.service.js';
import { EmailVerificationService } from '../services/email-verification.service.js';
import type { UserSecurityTokenService } from '../services/user-security-token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const USER_ID = '123e4567-e89b-42d3-a456-426614174002';
const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';
const TOKEN = 'T'.repeat(43);
const TOKEN_HASH = 'hash-of-the-token';
const NOW = new Date('2026-06-15T12:00:00Z');

function setup() {
  const manager = {
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const serializableTransaction = vi.fn(
    (operation: (client: unknown) => Promise<unknown>) => operation(manager),
  );
  const prisma = {
    serializableTransaction,
    user: {
      findUnique: vi.fn().mockResolvedValue({ emailVerifiedAt: null }),
    },
  };
  const tokens = {
    issue: vi.fn().mockResolvedValue({ id: ROW_ID }),
    hash: vi.fn().mockReturnValue(TOKEN_HASH),
    isUsable: vi.fn().mockResolvedValue(true),
    consume: vi.fn().mockResolvedValue(USER_ID),
  };
  const emailQueue = { enqueue: vi.fn().mockResolvedValue(true) };
  const auditEvent = { eventId: 'event-1' };
  const logging = {
    application: vi.fn(),
    security: vi.fn(),
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new EmailVerificationService(
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

describe('EmailVerificationService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('issueFor', () => {
    it('asks for a verification token valid for a day, in the caller transaction', async () => {
      const { service, manager, tokens } = setup();

      await service.issueFor(manager as never, USER_ID);

      expect(tokens.issue).toHaveBeenCalledWith(
        manager,
        USER_ID,
        'EMAIL_VERIFICATION',
        EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
      );
    });

    it('returns the id of the new token', async () => {
      const { service, manager } = setup();

      await expect(
        service.issueFor(manager as never, USER_ID),
      ).resolves.toEqual({
        id: ROW_ID,
      });
    });
  });

  describe('enqueue', () => {
    it('queues a verification email for the token', async () => {
      const { service, emailQueue } = setup();

      await service.enqueue(ROW_ID);

      expect(emailQueue.enqueue).toHaveBeenCalledExactlyOnceWith(
        'email-verification',
        ROW_ID,
      );
    });

    it('reports whether the queue accepted it', async () => {
      const { service, emailQueue } = setup();
      emailQueue.enqueue.mockResolvedValue(false);

      await expect(service.enqueue(ROW_ID)).resolves.toBe(false);
    });
  });

  describe('sendTo', () => {
    it('issues a token for the account and queues its email', async () => {
      const { service, tokens, emailQueue } = setup();

      await service.sendTo(USER_ID);

      expect(tokens.issue).toHaveBeenCalledWith(
        expect.anything(),
        USER_ID,
        'EMAIL_VERIFICATION',
        EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
      );
      expect(emailQueue.enqueue).toHaveBeenCalledWith(
        'email-verification',
        ROW_ID,
      );
    });

    it('queues the email only after the transaction', async () => {
      const { service, serializableTransaction, emailQueue } = setup();

      await service.sendTo(USER_ID);

      expect(serializableTransaction.mock.invocationCallOrder[0]).toBeLessThan(
        emailQueue.enqueue.mock.invocationCallOrder[0],
      );
    });

    describe('when something fails', () => {
      it.each([
        [
          'the token cannot be saved',
          (ctx: ReturnType<typeof setup>) =>
            ctx.tokens.issue.mockRejectedValue(new Error('database down')),
        ],
        [
          'the queue throws',
          (ctx: ReturnType<typeof setup>) =>
            ctx.emailQueue.enqueue.mockRejectedValue(new Error('redis down')),
        ],
      ])('does not fail the caller when %s', async (_, fail) => {
        const ctx = setup();
        fail(ctx);

        await expect(ctx.service.sendTo(USER_ID)).resolves.toBeUndefined();
      });

      it('logs a fixed event without the error', async () => {
        const ctx = setup();
        ctx.tokens.issue.mockRejectedValue(new Error('private details'));

        await ctx.service.sendTo(USER_ID);

        expect(ctx.logging.application).toHaveBeenCalledExactlyOnceWith({
          event: 'account_email.enqueue_unavailable',
          queue: 'account-email',
          kind: 'email-verification',
        });
      });

      it('queues nothing when the token cannot be saved', async () => {
        const ctx = setup();
        ctx.tokens.issue.mockRejectedValue(new Error('database down'));

        await ctx.service.sendTo(USER_ID);

        expect(ctx.emailQueue.enqueue).not.toHaveBeenCalled();
      });
    });
  });

  describe('resend', () => {
    it('looks up the active account', async () => {
      const { service, prisma } = setup();

      await service.resend(USER_ID);

      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: USER_ID, deletedAt: null },
        select: { emailVerifiedAt: true },
      });
    });

    it('requires authentication when the account is gone', async () => {
      const { service, prisma } = setup();
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.resend(USER_ID)).rejects.toMatchObject({
        status: 401,
      });
    });

    describe('for an account that is already verified', () => {
      const verified = () => {
        const ctx = setup();
        ctx.prisma.user.findUnique.mockResolvedValue({ emailVerifiedAt: NOW });
        return ctx;
      };

      it('issues no token', async () => {
        const { service, tokens } = verified();

        await service.resend(USER_ID);

        expect(tokens.issue).not.toHaveBeenCalled();
      });

      it('sends no email', async () => {
        const { service, emailQueue } = verified();

        await service.resend(USER_ID);

        expect(emailQueue.enqueue).not.toHaveBeenCalled();
      });
    });

    describe('for an account that is not verified', () => {
      it('issues a new token', async () => {
        const { service, tokens } = setup();

        await service.resend(USER_ID);

        expect(tokens.issue).toHaveBeenCalledWith(
          expect.anything(),
          USER_ID,
          'EMAIL_VERIFICATION',
          EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
        );
      });

      it('queues its email after the transaction', async () => {
        const { service, serializableTransaction, emailQueue } = setup();

        await service.resend(USER_ID);

        expect(emailQueue.enqueue).toHaveBeenCalledWith(
          'email-verification',
          ROW_ID,
        );
        expect(
          serializableTransaction.mock.invocationCallOrder[0],
        ).toBeLessThan(emailQueue.enqueue.mock.invocationCallOrder[0]);
      });
    });
  });

  describe('verify', () => {
    const verify = (service: EmailVerificationService) =>
      service.verify(TOKEN, '10.0.0.1', 'agent');

    describe('with a token that cannot be used', () => {
      const unusable = () => {
        const ctx = setup();
        ctx.tokens.isUsable.mockResolvedValue(false);
        return ctx;
      };

      it('is refused with one generic error', async () => {
        const { service } = unusable();

        await expect(verify(service)).rejects.toMatchObject({
          status: 400,
          message: 'Invalid or expired token',
        });
      });

      it('is checked by its hash and type', async () => {
        const { service, prisma, tokens } = unusable();

        await verify(service).catch(() => undefined);

        expect(tokens.isUsable).toHaveBeenCalledWith(
          prisma,
          'EMAIL_VERIFICATION',
          TOKEN_HASH,
        );
      });

      it('changes nothing', async () => {
        const { service, serializableTransaction } = unusable();

        await verify(service).catch(() => undefined);

        expect(serializableTransaction).not.toHaveBeenCalled();
      });

      it('records the rejection without the token', async () => {
        const { service, logging } = unusable();

        await verify(service).catch(() => undefined);

        expect(logging.security).toHaveBeenCalledExactlyOnceWith({
          action: 'auth.email_verification.failed',
          actor: { type: 'ANONYMOUS' },
          reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
          requestContext: expect.objectContaining({
            sourceIp: '10.0.0.1',
            userAgent: 'agent',
          }),
        });
      });
    });

    describe('with a usable token', () => {
      it('uses the token up inside the transaction', async () => {
        const { service, manager, tokens } = setup();

        await verify(service);

        expect(tokens.consume).toHaveBeenCalledWith(
          manager,
          'EMAIL_VERIFICATION',
          TOKEN_HASH,
        );
      });

      it('marks the active account as verified now', async () => {
        const { service, manager } = setup();

        await verify(service);

        expect(manager.user.updateMany).toHaveBeenCalledWith({
          where: { id: USER_ID, deletedAt: null },
          data: { emailVerifiedAt: NOW },
        });
      });

      it('audits the verification without the address', async () => {
        const { service, logging, manager } = setup();

        await verify(service);

        expect(logging.audit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            action: 'user.email.verified',
            actor: { type: 'ANONYMOUS' },
            target: { type: 'USER', id: USER_ID },
            payload: { method: 'EMAIL_LINK' },
          }),
          manager,
        );
      });

      it('publishes the audit copy of the stored event', async () => {
        const { service, logging, auditEvent } = setup();

        await verify(service);

        expect(logging.publishCommittedAudit).toHaveBeenCalledExactlyOnceWith(
          auditEvent,
        );
      });

      it('publishes it only after the transaction', async () => {
        const { service, serializableTransaction, logging } = setup();

        await verify(service);

        expect(
          serializableTransaction.mock.invocationCallOrder[0],
        ).toBeLessThan(
          logging.publishCommittedAudit.mock.invocationCallOrder[0],
        );
      });

      it('records no rejection', async () => {
        const { service, logging } = setup();

        await verify(service);

        expect(logging.security).not.toHaveBeenCalled();
      });
    });

    describe('when the token is lost between the check and the change', () => {
      it.each([
        [
          'another request used it first',
          (ctx: ReturnType<typeof setup>) =>
            ctx.tokens.consume.mockRejectedValue(
              new InvalidSecurityTokenException(),
            ),
        ],
        [
          'the account was deleted',
          (ctx: ReturnType<typeof setup>) =>
            ctx.manager.user.updateMany.mockResolvedValue({ count: 0 }),
        ],
      ])('rejects it as generic when %s', async (_, lose) => {
        const ctx = setup();
        lose(ctx);

        await expect(verify(ctx.service)).rejects.toMatchObject({
          status: 400,
          message: 'Invalid or expired token',
        });
      });

      it('records the rejection and publishes no audit copy', async () => {
        const ctx = setup();
        ctx.manager.user.updateMany.mockResolvedValue({ count: 0 });

        await verify(ctx.service).catch(() => undefined);

        expect(ctx.logging.security).toHaveBeenCalledWith(
          expect.objectContaining({ action: 'auth.email_verification.failed' }),
        );
        expect(ctx.logging.publishCommittedAudit).not.toHaveBeenCalled();
      });
    });

    it('passes on an unexpected failure without calling it a bad token', async () => {
      const ctx = setup();
      ctx.manager.user.updateMany.mockRejectedValue(new Error('database down'));

      await expect(verify(ctx.service)).rejects.toThrow('database down');
    });
  });
});
