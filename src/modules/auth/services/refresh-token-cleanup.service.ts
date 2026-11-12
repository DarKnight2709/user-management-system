import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { backgroundErrorCategory } from '@/common/utils/background-error-category.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
  REFRESH_TOKEN_CLEANUP_INTERVAL_MS,
  REFRESH_TOKEN_CLEANUP_MAX_BATCHES,
  REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS,
} from '../constants/auth.constant.js';

/**
 * Deletes refresh tokens that expired a while ago. Rows that are revoked but
 * not yet expired stay: replaying one of them is how token reuse is detected.
 * Repeating a run, or running on several instances, is harmless.
 */
@Injectable()
export class RefreshTokenCleanupService
  implements OnModuleInit, OnModuleDestroy
{
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private activeRun?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly logging: LoggingService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.deleteExpired(),
      REFRESH_TOKEN_CLEANUP_INTERVAL_MS,
    );
    this.timer.unref();
    void this.deleteExpired();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeRun;
  }

  async deleteExpired(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.activeRun = this.deleteExpiredInBatches().catch((error: unknown) => {
      this.logging.application({
        event: 'auth.refresh_token_cleanup_failed',
        errorCategory: backgroundErrorCategory(error),
      });
    });
    try {
      await this.activeRun;
    } finally {
      this.running = false;
    }
  }

  private async deleteExpiredInBatches(): Promise<void> {
    const cutoff = new Date(
      Date.now() - REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS,
    );

    for (
      let batch = 0;
      batch < REFRESH_TOKEN_CLEANUP_MAX_BATCHES && !this.stopped;
      batch++
    ) {
      const deleted = await this.deleteExpiredBatch(cutoff);
      if (deleted < REFRESH_TOKEN_CLEANUP_BATCH_SIZE) return;
    }
  }

  private async deleteExpiredBatch(cutoff: Date): Promise<number> {
    const expired = await this.prisma.refreshToken.findMany({
      where: { expiresAt: { lt: cutoff } },
      select: { id: true },
      take: REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
    });
    if (expired.length === 0) return 0;

    // Re-check expiry in the delete so a row can never be removed by mistake.
    const { count } = await this.prisma.refreshToken.deleteMany({
      where: {
        id: { in: expired.map(({ id }) => id) },
        expiresAt: { lt: cutoff },
      },
    });
    return count;
  }
}
