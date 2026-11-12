import { UnrecoverableError } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { EmailService } from '@/core/email/email.service.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { UserSecurityTokenType } from '@/generated/prisma/enums.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { SecurityTokenEmailDeliveryService } from '../services/security-token-email-delivery.service.js';
import type { UserSecurityTokenService } from '../services/user-security-token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';
const EXPIRES_AT = new Date('2026-06-15T12:30:00Z');
const LINK = 'https://app.example.com/page#token=secret-token';

function setup() {
  const findFirst = vi.fn().mockResolvedValue({
    id: ROW_ID,
    expiresAt: EXPIRES_AT,
    user: { email: 'alice@example.com' },
  });
  const tokens = { linkFor: vi.fn().mockReturnValue(LINK) };
  const sendPasswordResetEmail = vi.fn().mockResolvedValue(undefined);
  const sendEmailVerificationEmail = vi.fn().mockResolvedValue(undefined);
  const application = vi.fn();
  const service = new SecurityTokenEmailDeliveryService(
    { userSecurityToken: { findFirst } } as unknown as PrismaService,
    tokens as unknown as UserSecurityTokenService,
    {
      sendPasswordResetEmail,
      sendEmailVerificationEmail,
    } as unknown as EmailService,
    { application } as unknown as LoggingService,
  );
  return {
    service,
    findFirst,
    tokens,
    sendPasswordResetEmail,
    sendEmailVerificationEmail,
    application,
  };
}

type Setup = ReturnType<typeof setup>;

// What differs between the two kinds of emailed token.
const KINDS = [
  {
    type: 'PASSWORD_RESET' as UserSecurityTokenType,
    kind: 'password-reset',
    userFilter: { deletedAt: null },
    sender: (ctx: Setup) => ctx.sendPasswordResetEmail,
    message: {
      to: 'alice@example.com',
      resetLink: LINK,
      expiresAt: EXPIRES_AT,
    },
  },
  {
    type: 'EMAIL_VERIFICATION' as UserSecurityTokenType,
    kind: 'email-verification',
    userFilter: { deletedAt: null, emailVerifiedAt: null },
    sender: (ctx: Setup) => ctx.sendEmailVerificationEmail,
    message: {
      to: 'alice@example.com',
      verifyLink: LINK,
      expiresAt: EXPIRES_AT,
    },
  },
];

describe('SecurityTokenEmailDeliveryService', () => {
  describe.each(KINDS)('for a $type token', (kind) => {
    const { type } = kind;

    describe('the job', () => {
      it.each([
        ['no data', undefined],
        ['a missing id', {}],
        ['an id that is not a string', { tokenId: 42 }],
        ['an id that is not a UUID', { tokenId: 'not-a-uuid' }],
      ])('is not retried when it has %s', async (_, data) => {
        const { service } = setup();

        await expect(
          service.deliver(type, data as unknown as { tokenId: string }),
        ).rejects.toBeInstanceOf(UnrecoverableError);
      });
    });

    describe('finding the token', () => {
      it('only takes a token of this type that is unused, unexpired and of a fitting account', async () => {
        const { service, findFirst } = setup();

        await service.deliver(type, { tokenId: ROW_ID });

        expect(findFirst).toHaveBeenCalledWith({
          where: {
            id: ROW_ID,
            type,
            consumedAt: null,
            expiresAt: { gt: expect.any(Date) },
            user: kind.userFilter,
          },
          select: {
            id: true,
            expiresAt: true,
            user: { select: { email: true } },
          },
        });
      });

      it('sends nothing when the token is gone, used or expired', async () => {
        const ctx = setup();
        ctx.findFirst.mockResolvedValue(null);

        await ctx.service.deliver(type, { tokenId: ROW_ID });

        expect(kind.sender(ctx)).not.toHaveBeenCalled();
      });
    });

    describe('sending', () => {
      it('rebuilds the link from the row id and the token type', async () => {
        const { service, tokens } = setup();

        await service.deliver(type, { tokenId: ROW_ID });

        expect(tokens.linkFor).toHaveBeenCalledWith(type, ROW_ID);
      });

      it('emails the account address with the link and its expiry', async () => {
        const ctx = setup();

        await ctx.service.deliver(type, { tokenId: ROW_ID });

        expect(kind.sender(ctx)).toHaveBeenCalledExactlyOnceWith(kind.message);
      });

      it('logs nothing when it succeeds', async () => {
        const { service, application } = setup();

        await service.deliver(type, { tokenId: ROW_ID });

        expect(application).not.toHaveBeenCalled();
      });
    });

    describe('a failure', () => {
      it.each([
        [
          'reading the database',
          (ctx: Setup) =>
            ctx.findFirst.mockRejectedValue(new Error('private address')),
          'database-read',
        ],
        [
          'building the link',
          (ctx: Setup) =>
            ctx.tokens.linkFor.mockImplementation(() => {
              throw new Error('private secret');
            }),
          'link-configuration',
        ],
        [
          'sending the email',
          (ctx: Setup) =>
            kind.sender(ctx).mockRejectedValue(
              Object.assign(new Error('private response'), {
                code: 'ETIMEDOUT',
              }),
            ),
          'smtp-send',
        ],
      ])(
        'while %s is logged with its kind and stage',
        async (_, fail, stage) => {
          const ctx = setup();
          fail(ctx);

          await ctx.service
            .deliver(type, { tokenId: ROW_ID })
            .catch(() => undefined);

          expect(ctx.application).toHaveBeenCalledWith(
            expect.objectContaining({
              event: 'account_email.delivery_failed',
              kind: kind.kind,
              stage,
            }),
          );
        },
      );

      it('is logged without the error text, address or link', async () => {
        const ctx = setup();
        kind
          .sender(ctx)
          .mockRejectedValue(
            new Error('private alice@example.com secret-token'),
          );

        await ctx.service
          .deliver(type, { tokenId: ROW_ID })
          .catch(() => undefined);

        expect(JSON.stringify(ctx.application.mock.calls)).not.toMatch(
          /private|alice@example\.com|secret-token/,
        );
      });

      it('keeps a safe error code from the mail provider', async () => {
        const ctx = setup();
        kind
          .sender(ctx)
          .mockRejectedValue(
            Object.assign(new Error('x'), { code: 'ETIMEDOUT' }),
          );

        await ctx.service
          .deliver(type, { tokenId: ROW_ID })
          .catch(() => undefined);

        expect(ctx.application).toHaveBeenCalledWith(
          expect.objectContaining({ code: 'ETIMEDOUT' }),
        );
      });

      it('is raised again with a message that holds no detail, so the job is retried', async () => {
        const ctx = setup();
        kind
          .sender(ctx)
          .mockRejectedValue(new Error('private alice@example.com'));

        await expect(
          ctx.service.deliver(type, { tokenId: ROW_ID }),
        ).rejects.toThrow('Account email delivery failed');
      });
    });
  });

  describe('which email each type sends', () => {
    it('does not send a verification email for a password reset token', async () => {
      const { service, sendEmailVerificationEmail } = setup();

      await service.deliver('PASSWORD_RESET', { tokenId: ROW_ID });

      expect(sendEmailVerificationEmail).not.toHaveBeenCalled();
    });

    it('does not send a password reset email for a verification token', async () => {
      const { service, sendPasswordResetEmail } = setup();

      await service.deliver('EMAIL_VERIFICATION', { tokenId: ROW_ID });

      expect(sendPasswordResetEmail).not.toHaveBeenCalled();
    });
  });
});
