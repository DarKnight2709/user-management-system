import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/core/database/prisma.service.js';
import { S3Service } from '@/core/storage/s3.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { AvatarCleanupService } from './avatar-cleanup.service.js';
import { UsersService } from './users.service.js';

/** Grace period because a timed-out upload may still finish in storage. */
const UPLOAD_RECOVERY_GRACE_MS = 3_600_000;

@Injectable()
export class UserAvatarService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3Service: S3Service,
    private readonly avatarCleanup: AvatarCleanupService,
    private readonly logging: LoggingService,
    private readonly users: UsersService,
  ) {}

  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ key: string; avatarUrl: string | null }> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }
    await this.users.findOne(userId);

    const key = `${userId}-${randomUUID()}.jpg`;
    // Persist recovery before touching storage. A crash leaves a retryable task.
    await this.prisma.avatarCleanupTask.create({
      data: {
        objectKey: key,
        nextAttemptAt: new Date(Date.now() + UPLOAD_RECOVERY_GRACE_MS),
      },
    });
    await this.s3Service.upload(key, file.buffer, 'image/jpeg');

    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        const user = await manager.user.findUnique({
          where: { id: userId, deletedAt: null },
          select: { avatarKey: true },
        });
        if (!user) throw new NotFoundException('User not found');
        await manager.user.update({
          where: { id: userId, deletedAt: null },
          data: { avatarKey: key },
        });
        if (user.avatarKey) {
          await manager.avatarCleanupTask.upsert({
            where: { objectKey: user.avatarKey },
            create: { objectKey: user.avatarKey },
            update: { nextAttemptAt: new Date() },
          });
        }
        // New object is now owned by the user; cancel its recovery task.
        await manager.avatarCleanupTask.delete({ where: { objectKey: key } });

        return this.logging.audit(
          {
            action: 'user.avatar.updated',
            actor: { type: 'USER', id: userId },
            target: { type: 'USER', id: userId },
            payload: { change: user.avatarKey ? 'REPLACED' : 'ADDED' },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
      },
    );

    this.logging.publishCommittedAudit(auditEvent);
    void this.avatarCleanup.processDue();

    return { key, avatarUrl: this.s3Service.getPublicUrl(key) };
  }
}
