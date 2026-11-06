import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { compare, hash } from '@/common/utils/hash.util.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { ChangePasswordDto } from '../dto/change-password.dto.js';
import { authRequestContext } from '../utils/auth-request-context.util.js';

@Injectable()
export class PasswordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  /** Replaces the password and revokes every refresh session atomically. */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { hashedPassword: true },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid current password');
    }

    const isCurrentPasswordValid = await compare(
      dto.currentPassword,
      user.hashedPassword,
    );
    if (!isCurrentPasswordValid) {
      this.logging.security({
        action: 'auth.password.change_failed',
        actor: { type: 'USER', id: userId },
        reasonCode: 'INVALID_CURRENT_PASSWORD',
        requestContext: authRequestContext(ipAddress, userAgent),
      });
      throw new UnauthorizedException('Invalid current password');
    }

    const isSamePassword = await compare(dto.newPassword, user.hashedPassword);
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must differ from the current password',
      );
    }

    const hashedPassword = await hash(dto.newPassword);
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        // Compare-and-swap on the old hash: a concurrent change fails this one.
        const updated = await manager.user.updateMany({
          where: {
            id: userId,
            deletedAt: null,
            hashedPassword: user.hashedPassword,
          },
          data: { hashedPassword },
        });
        if (updated.count !== 1) {
          throw new UnauthorizedException(
            'Account or password changed; authenticate again',
          );
        }
        const revoked = await manager.refreshToken.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });

        return this.logging.audit(
          {
            action: 'user.password.changed',
            actor: { type: 'USER', id: userId },
            target: { type: 'USER', id: userId },
            payload: { revokedRefreshTokenCount: revoked.count },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
      },
    );

    this.logging.publishCommittedAudit(auditEvent);
    this.logging.security({
      action: 'auth.password.changed',
      actor: { type: 'USER', id: userId },
      requestContext: authRequestContext(ipAddress, userAgent),
    });
  }
}
