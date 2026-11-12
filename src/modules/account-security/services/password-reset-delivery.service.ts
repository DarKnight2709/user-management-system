import { Injectable } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { safeEmailErrorDetails } from '@/core/email/email-error.util.js';
import { EmailService } from '@/core/email/email.service.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { AccountEmailDeliveryStage } from '@/modules/logging/types/application-event.types.js';
import type { AccountEmailJobData } from '../interfaces/account-email-job.interface.js';
import { UserSecurityTokenService } from './user-security-token.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Worker side of a password reset: rebuild the link and send the email. */
@Injectable()
export class PasswordResetDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: UserSecurityTokenService,
    private readonly email: EmailService,
    private readonly logging: LoggingService,
  ) {}

  async deliver(job: AccountEmailJobData): Promise<void> {
    this.validateJob(job);
    let stage: AccountEmailDeliveryStage = 'database-read';
    try {
      const token = await this.findDeliverableToken(job.tokenId);
      // Used, expired or replaced in the meantime, or the account is gone.
      if (!token) return;

      stage = 'link-configuration';
      const resetLink = this.tokens.linkFor('PASSWORD_RESET', token.id);

      stage = 'smtp-send';
      await this.email.sendPasswordResetEmail({
        to: token.user.email,
        resetLink,
        expiresAt: token.expiresAt,
      });
    } catch (error) {
      this.logging.application({
        event: 'account_email.delivery_failed',
        kind: 'password-reset',
        stage,
        ...safeEmailErrorDetails(error),
      });
      // BullMQ retries; the original error may hold the address or provider text.
      throw new Error('Password reset email delivery failed');
    }
  }

  private findDeliverableToken(tokenId: string) {
    return this.prisma.userSecurityToken.findFirst({
      where: {
        id: tokenId,
        type: 'PASSWORD_RESET',
        consumedAt: null,
        expiresAt: { gt: new Date() },
        user: { deletedAt: null },
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
