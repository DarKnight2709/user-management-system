import { Injectable } from '@nestjs/common';
import { hash } from '@/common/utils/hash.util.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { authRequestContext } from '@/modules/auth/utils/auth-request-context.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { StoredAuditEvent } from '@/modules/logging/types/audit-event.types.js';
import {
  FORGOT_PASSWORD_MIN_DURATION_MS,
  PASSWORD_RESET_TOKEN_LIFETIME_MS,
} from '../constants/account-security.constant.js';
import { InvalidSecurityTokenException } from '../invalid-security-token.exception.js';
import { AccountEmailQueueService } from './account-email-queue.service.js';
import { UserSecurityTokenService } from './user-security-token.service.js';

/**
 * Forgot and reset password. A reset replaces the password, revokes every
 * refresh session and uses up the token in one transaction.
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: UserSecurityTokenService,
    private readonly emailQueue: AccountEmailQueueService,
    private readonly logging: LoggingService,
  ) {}

  /**
   * Sends a reset link when the address belongs to an active account. It does
   * the same visible thing either way: nothing here tells the caller whether
   * the address exists, and a minimum duration hides the difference in work.
   */
  async requestReset(
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.issueResetLink(email, ipAddress, userAgent);
    } finally {
      await this.waitForMinimumDuration(startedAt);
    }
  }

  async resetPassword(
    token: string,
    newPassword: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const tokenHash = this.tokens.hash(token);

    // Cheap check first, so junk tokens never cost a password hash.
    if (!(await this.isUsable(tokenHash))) {
      this.rejectToken(ipAddress, userAgent);
    }

    const hashedPassword = await hash(newPassword);
    let auditEvent: StoredAuditEvent;
    try {
      auditEvent = await this.prisma.serializableTransaction((manager) =>
        this.applyReset(manager, tokenHash, hashedPassword),
      );
    } catch (error) {
      if (error instanceof InvalidSecurityTokenException) {
        this.rejectToken(ipAddress, userAgent);
      }
      throw error;
    }
    this.logging.publishCommittedAudit(auditEvent);
  }

  private async issueResetLink(
    email: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
      select: { id: true },
    });
    if (!user) return;

    const token = await this.prisma.serializableTransaction((manager) =>
      this.tokens.issue(
        manager,
        user.id,
        'PASSWORD_RESET',
        PASSWORD_RESET_TOKEN_LIFETIME_MS,
      ),
    );
    this.logging.security({
      action: 'auth.password_reset.requested',
      actor: { type: 'ANONYMOUS' },
      target: { type: 'USER', id: user.id },
      requestContext: authRequestContext(ipAddress, userAgent),
    });
    await this.emailQueue.enqueuePasswordReset(token.id);
  }

  private async isUsable(tokenHash: string): Promise<boolean> {
    const token = await this.prisma.userSecurityToken.findUnique({
      where: { tokenHash },
      select: {
        type: true,
        consumedAt: true,
        expiresAt: true,
        user: { select: { deletedAt: true } },
      },
    });
    return (
      token !== null &&
      token.type === 'PASSWORD_RESET' &&
      token.consumedAt === null &&
      token.expiresAt > new Date() &&
      token.user.deletedAt === null
    );
  }

  private async applyReset(
    manager: Prisma.TransactionClient,
    tokenHash: string,
    hashedPassword: string,
  ) {
    const token = await manager.userSecurityToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true },
    });
    if (!token) throw new InvalidSecurityTokenException();

    const now = new Date();
    // Only one of two simultaneous resets can use the token.
    const consumed = await manager.userSecurityToken.updateMany({
      where: {
        id: token.id,
        type: 'PASSWORD_RESET',
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) throw new InvalidSecurityTokenException();

    const updated = await manager.user.updateMany({
      where: { id: token.userId, deletedAt: null },
      data: { hashedPassword },
    });
    // A deleted account rolls the whole transaction back, token included.
    if (updated.count !== 1) throw new InvalidSecurityTokenException();

    const revoked = await manager.refreshToken.updateMany({
      where: { userId: token.userId, revokedAt: null },
      data: { revokedAt: now },
    });

    return this.logging.audit(
      {
        action: 'user.password.reset',
        actor: { type: 'ANONYMOUS' },
        target: { type: 'USER', id: token.userId },
        payload: { revokedRefreshTokenCount: revoked.count },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private rejectToken(ipAddress?: string, userAgent?: string): never {
    this.logging.security({
      action: 'auth.password_reset.failed',
      actor: { type: 'ANONYMOUS' },
      reasonCode: 'INVALID_OR_EXPIRED_TOKEN',
      requestContext: authRequestContext(ipAddress, userAgent),
    });
    throw new InvalidSecurityTokenException();
  }

  private async waitForMinimumDuration(startedAt: number): Promise<void> {
    const remainingMs =
      FORGOT_PASSWORD_MIN_DURATION_MS - (Date.now() - startedAt);
    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs));
    }
  }
}
