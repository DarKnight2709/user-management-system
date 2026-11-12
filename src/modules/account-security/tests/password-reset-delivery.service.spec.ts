import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { EmailService } from '@/core/email/email.service.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { PasswordResetDeliveryService } from '../services/password-reset-delivery.service.js';
import type { UserSecurityTokenService } from '../services/user-security-token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';
const EXPIRES_AT = new Date('2026-06-15T12:30:00Z');
const LINK = 'https://app.example.com/reset-password#token=secret-token';

function setup() {
  const findFirst = vi.fn().mockResolvedValue({
    id: ROW_ID,
    expiresAt: EXPIRES_AT,
    user: { email: 'alice@example.com' },
  });
  const tokens = { linkFor: vi.fn().mockReturnValue(LINK) };
  const sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
  const application = vi.fn();
  const service = new PasswordResetDeliveryService(
    { userSecurityToken: { findFirst } } as unknown as PrismaService,
    tokens as unknown as UserSecurityTokenService,
    { sendPasswordResetEmail } as unknown as EmailService,
    { application } as unknown as LoggingService,
  );
  return { service, findFirst, tokens, sendPasswordResetEmail, application };
}

describe('PasswordResetDeliveryService', () => {
  describe('the job', () => {
    it.each([
      ['no data', undefined],
      ['a missing id', {}],
      ['an id that is not a string', { tokenId: 42 }],
      ['an id that is not a UUID', { tokenId: 'not-a-uuid' }],
    ])('is not retried when it has %s', async (_, data) => {
      const { service } = setup();

      await expect(
        service.deliver(data as unknown as { tokenId: string }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });
  });

  describe('finding the token', () => {
    it('only takes a reset token that is unused, unexpired and of an active account', async () => {
      const { service, findFirst } = setup();

      await service.deliver({ tokenId: ROW_ID });

      expect(findFirst).toHaveBeenCalledWith({
        where: {
          id: ROW_ID,
          type: 'PASSWORD_RESET',
          consumedAt: null,
          expiresAt: { gt: expect.any(Date) },
          user: { deletedAt: null },
        },
        select: {
          id: true,
          expiresAt: true,
          user: { select: { email: true } },
        },
      });
    });

    it('sends nothing when the token is gone, used or expired', async () => {
      const { service, findFirst, sendPasswordResetEmail } = setup();
      findFirst.mockResolvedValue(null);

      await service.deliver({ tokenId: ROW_ID });

      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });

  describe('sending', () => {
    it('rebuilds the link from the row id', async () => {
      const { service, tokens } = setup();

      await service.deliver({ tokenId: ROW_ID });

      expect(tokens.linkFor).toHaveBeenCalledWith('PASSWORD_RESET', ROW_ID);
    });

    it('emails the account address with the link and its expiry', async () => {
      const { service, sendPasswordResetEmail } = setup();

      await service.deliver({ tokenId: ROW_ID });

      expect(sendPasswordResetEmail).toHaveBeenCalledExactlyOnceWith({
        to: 'alice@example.com',
        resetLink: LINK,
        expiresAt: EXPIRES_AT,
      });
    });

    it('logs nothing when it succeeds', async () => {
      const { service, application } = setup();

      await service.deliver({ tokenId: ROW_ID });

      expect(application).not.toHaveBeenCalled();
    });
  });

  describe('a failure', () => {
    it.each([
      [
        'reading the database',
        (ctx: ReturnType<typeof setup>) =>
          ctx.findFirst.mockRejectedValue(new Error('private address')),
        'database-read',
      ],
      [
        'building the link',
        (ctx: ReturnType<typeof setup>) =>
          ctx.tokens.linkFor.mockImplementation(() => {
            throw new Error('private secret');
          }),
        'link-configuration',
      ],
      [
        'sending the email',
        (ctx: ReturnType<typeof setup>) =>
          ctx.sendPasswordResetEmail.mockRejectedValue(
            Object.assign(new Error('private response'), { code: 'ETIMEDOUT' }),
          ),
        'smtp-send',
      ],
    ])('while %s is logged with its stage', async (_, fail, stage) => {
      const ctx = setup();
      fail(ctx);

      await ctx.service.deliver({ tokenId: ROW_ID }).catch(() => undefined);

      expect(ctx.application).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'account_email.delivery_failed',
          kind: 'password-reset',
          stage,
        }),
      );
    });

    it('is logged without the error text, address or link', async () => {
      const ctx = setup();
      ctx.sendPasswordResetEmail.mockRejectedValue(
        new Error('private alice@example.com secret-token'),
      );

      await ctx.service.deliver({ tokenId: ROW_ID }).catch(() => undefined);

      const logged = JSON.stringify(ctx.application.mock.calls);
      expect(logged).not.toMatch(/private|alice@example\.com|secret-token/);
    });

    it('keeps a safe error code from the mail provider', async () => {
      const ctx = setup();
      ctx.sendPasswordResetEmail.mockRejectedValue(
        Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
      );

      await ctx.service.deliver({ tokenId: ROW_ID }).catch(() => undefined);

      expect(ctx.application).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'ETIMEDOUT' }),
      );
    });

    it('is raised again with a message that holds no detail, so the job is retried', async () => {
      const ctx = setup();
      ctx.sendPasswordResetEmail.mockRejectedValue(
        new Error('private alice@example.com'),
      );

      await expect(ctx.service.deliver({ tokenId: ROW_ID })).rejects.toThrow(
        'Password reset email delivery failed',
      );
    });
  });
});
