import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { PrismaService } from '@/core/database/prisma.service.js';
import { safeEmailErrorDetails } from '@/core/email/email-error.util.js';
import { EmailService } from '@/core/email/email.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type { UserSecurityTokenType } from '@/generated/prisma/enums.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type {
  AccountEmailDeliveryStage,
  AccountEmailKind,
} from '@/modules/logging/types/application-event.types.js';
import type { AccountEmailJobData } from '../interfaces/account-email-job.interface.js';
import { UserSecurityTokenService } from './user-security-token.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface TokenEmail {
  to: string;
  link: string;
  expiresAt: Date;
}

interface DeliveryKind {
  kind: AccountEmailKind;
  /** Accounts the email still makes sense for when the job runs. */
  userFilter: Prisma.UserWhereInput;
  send(email: EmailService, message: TokenEmail): Promise<void>;
}

const DELIVERY_KINDS: Record<UserSecurityTokenType, DeliveryKind> = {
  PASSWORD_RESET: {
    kind: 'password-reset',
    userFilter: { deletedAt: null },
    send: (email, { to, link, expiresAt }) =>
      email.sendPasswordResetEmail({ to, resetLink: link, expiresAt }),
  },
  EMAIL_VERIFICATION: {
    kind: 'email-verification',
    // A verified address needs no email, whatever was queued earlier.
    userFilter: { deletedAt: null, emailVerifiedAt: null },
    send: (email, { to, link, expiresAt }) =>
      email.sendEmailVerificationEmail({ to, verifyLink: link, expiresAt }),
  },
};

/** Worker side of an emailed token: rebuild the link and send the email. */
@Injectable()
export class SecurityTokenEmailDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: UserSecurityTokenService,
    private readonly email: EmailService,
    private readonly logging: LoggingService,
  ) {}

  async deliver(
    type: UserSecurityTokenType,
    job: AccountEmailJobData,
  ): Promise<void> {
    this.validateJob(job);
    const delivery = DELIVERY_KINDS[type];
    let stage: AccountEmailDeliveryStage = 'database-read';
    try {
      const token = await this.findDeliverableToken(type, job.tokenId);
      // Used, expired or replaced in the meantime, or the account is gone.
      if (!token) return;

      stage = 'link-configuration';
      const link = this.tokens.linkFor(type, token.id);

      stage = 'smtp-send';
      await delivery.send(this.email, {
        to: token.user.email,
        link,
        expiresAt: token.expiresAt,
      });
    } catch (error) {
      this.logging.application({
        event: 'account_email.delivery_failed',
        kind: delivery.kind,
        stage,
        ...safeEmailErrorDetails(error),
      });
      // BullMQ retries; the original error may hold the address or provider text.
      throw new Error('Account email delivery failed');
    }
  }

  private findDeliverableToken(type: UserSecurityTokenType, tokenId: string) {
    return this.prisma.userSecurityToken.findFirst({
      where: {
        id: tokenId,
        type,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        user: DELIVERY_KINDS[type].userFilter,
      },
      select: {
        id: true,
        expiresAt: true,
        user: { select: { email: true } },
      },
    });
  }

  private validateJob(job: AccountEmailJobData): void {
    if (typeof job?.tokenId !== 'string' || !UUID_PATTERN.test(job.tokenId)) {
      throw new UnrecoverableError('Invalid account email job');
    }
  }
}
