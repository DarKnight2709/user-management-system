import { Injectable, UnauthorizedException } from '@nestjs/common';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { authRequestContext } from '@/modules/auth/utils/auth-request-context.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { StoredAuditEvent } from '@/modules/logging/types/audit-event.types.js';
import {
  ACCOUNT_EMAIL_QUEUE,
  EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
} from '../constants/account-security.constant.js';
import { InvalidSecurityTokenException } from '../invalid-security-token.exception.js';
import { AccountEmailQueueService } from './account-email-queue.service.js';
import { UserSecurityTokenService } from './user-security-token.service.js';

/**
 * Proves that an account owner can read the mailbox of the address on file.
 * The address is never part of the token: changing it deletes the open token,
 * so a link only ever verifies the address it was sent to.
 */
@Injectable()
export class EmailVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: UserSecurityTokenService,
    private readonly emailQueue: AccountEmailQueueService,
    private readonly logging: LoggingService,
  ) {}

  /** Inside the caller's transaction: a new token that replaces any open one. */
  issueFor(
    manager: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string }> {
    return this.tokens.issue(
      manager,
      userId,
      'EMAIL_VERIFICATION',
      EMAIL_VERIFICATION_TOKEN_LIFETIME_MS,
    );
  }

  /** After the caller's transaction has committed. */
  enqueue(tokenId: string): Promise<boolean> {
    return this.emailQueue.enqueue('email-verification', tokenId);
  }

  /**
   * For a new account: it must never fail the registration that triggered it.
   * If it does fail, the person can ask again once signed in.
   */
  async sendTo(userId: string): Promise<void> {
    try {
      const token = await this.prisma.serializableTransaction((manager) =>
        this.issueFor(manager, userId),
      );
      await this.enqueue(token.id);
    } catch {
      this.logging.application({
        event: 'account_email.enqueue_unavailable',
        queue: ACCOUNT_EMAIL_QUEUE,
        kind: 'email-verification',
      });
    }
  }

  /** Signed-in person asks for another link; nothing to do once verified. */
  async resend(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { emailVerifiedAt: true },
    });
    if (!user) throw new UnauthorizedException('Authentication required');
    if (user.emailVerifiedAt) return;

    const token = await this.prisma.serializableTransaction((manager) =>
      this.issueFor(manager, userId),
    );
    await this.enqueue(token.id);
  }

  async verify(
    token: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const tokenHash = this.tokens.hash(token);
    if (
      !(await this.tokens.isUsable(
        this.prisma,
        'EMAIL_VERIFICATION',
        tokenHash,
      ))
    ) {
      this.rejectToken(ipAddress, userAgent);
    }

    let auditEvent: StoredAuditEvent;
    try {
      auditEvent = await this.prisma.serializableTransaction((manager) =>
        this.markVerified(manager, tokenHash),
      );
    } catch (error) {
      if (error instanceof InvalidSecurityTokenException) {
        this.rejectToken(ipAddress, userAgent);
      }
      throw error;
    }
    this.logging.publishCommittedAudit(auditEvent);
  }

  private async markVerified(
    manager: Prisma.TransactionClient,
    tokenHash: string,
  ) {
    const userId = await this.tokens.consume(
      manager,
      'EMAIL_VERIFICATION',
      tokenHash,
    );

    const updated = await manager.user.updateMany({
      where: { id: userId, deletedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
    // A deleted account rolls the whole transaction back, token included.
    if (updated.count !== 1) throw new InvalidSecurityTokenException();

    return this.logging.audit(
      {
        action: 'user.email.verified',
        actor: { type: 'ANONYMOUS' },
        target: { type: 'USER', id: userId },
        payload: { method: 'EMAIL_LINK' },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private rejectToken(ipAddress?: string, userAgent?: string): never {
    this.logging.security({
      action: 'auth.email_verification.failed',
      actor: { type: 'ANONYMOUS' },
      reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
      requestContext: authRequestContext(ipAddress, userAgent),
    });
    throw new InvalidSecurityTokenException();
  }
}
