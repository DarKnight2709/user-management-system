import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/core/database/prisma.service.js';
import { S3Service } from '@/core/storage/s3.service.js';
import { Prisma } from '@/generated/prisma/client.js';

@Injectable()
export class AvatarCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarCleanupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private activeRun?: Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3Service,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.processDue(), 30_000);
    this.timer.unref();
    void this.processDue();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  async processDue(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.activeRun = this.processBatch().catch((error: unknown) => {
      this.logger.error({
        event: 'avatar_cleanup_worker_failed',
        errorCategory: this.getErrorCategory(error),
      });
    });
    try {
      await this.activeRun;
    } finally {
      this.running = false;
    }
  }

  private async processBatch(): Promise<void> {
    const now = new Date();
    const tasks = await this.prisma.avatarCleanupTask.findMany({
      where: {
        nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: 20,
    });

    for (const task of tasks) {
      if (this.stopped) break;
      const leaseToken = randomUUID();
      const claimed = await this.prisma.avatarCleanupTask.updateMany({
        where: {
          id: task.id,
          nextAttemptAt: { lte: new Date() },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
        },
        data: { leaseToken, leaseUntil: new Date(Date.now() + 120_000) },
      });
      if (claimed.count !== 1) continue;

      try {
        // Preserve current avatars, including those retained by soft-deleted users.
        const referenced = await this.prisma.user.findFirst({
          where: { avatarKey: task.objectKey },
          select: { id: true },
        });
        if (!referenced) await this.storage.delete(task.objectKey);
        await this.prisma.avatarCleanupTask.deleteMany({
          where: { id: task.id, leaseToken },
        });
      } catch (error) {
        const delayMs = Math.min(
          3_600_000,
          30_000 * 2 ** Math.min(task.attempts, 7),
        );
        const nextAttemptAt = new Date(Date.now() + delayMs);
        let scheduled: { count: number };
        try {
          scheduled = await this.prisma.avatarCleanupTask.updateMany({
            where: { id: task.id, leaseToken },
            data: {
              attempts: { increment: 1 },
              nextAttemptAt,
              leaseToken: null,
              leaseUntil: null,
            },
          });
        } catch (schedulingError) {
          this.logger.error({
            event: 'avatar_cleanup_retry_scheduling_failed',
            taskId: task.id,
            attempt: task.attempts + 1,
            errorCategory: this.getErrorCategory(error),
            schedulingErrorCategory: this.getErrorCategory(schedulingError),
          });
          throw schedulingError;
        }
        if (scheduled.count !== 1) continue;
        this.logger.warn({
          event: 'avatar_cleanup_retry_scheduled',
          taskId: task.id,
          attempt: task.attempts + 1,
          errorCategory: this.getErrorCategory(error),
          retryDelayMs: delayMs,
          nextAttemptAt: nextAttemptAt.toISOString(),
        });
      }
    }
  }

  private getErrorCategory(error: unknown): string {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Prisma.PrismaClientUnknownRequestError ||
      error instanceof Prisma.PrismaClientInitializationError ||
      error instanceof Prisma.PrismaClientValidationError
    ) {
      return 'database';
    }
    if (!(error instanceof Error)) return 'unknown';
    switch (error.name) {
      case 'AbortError':
      case 'TimeoutError':
        return 'timeout';
      case 'AccessDenied':
      case 'InvalidAccessKeyId':
      case 'SignatureDoesNotMatch':
        return 'storage_authorization';
      case 'NoSuchBucket':
        return 'storage_bucket_missing';
      case 'SlowDown':
      case 'ServiceUnavailable':
        return 'storage_unavailable';
      default:
        return 'unknown';
    }
  }
}
