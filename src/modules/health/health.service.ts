import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';

@Injectable()
export class HealthService {
  private databaseCheck?: Promise<void>;

  constructor(private readonly prisma: PrismaService) {}

  async ready(): Promise<{ status: 'ok'; checks: { database: 'up' } }> {
    // Share overlapping probes rather than queueing more database work during outages.
    if (!this.databaseCheck) {
      this.databaseCheck = this.prisma
        .$transaction(
          async (manager) => {
            // An empty users table is healthy too; no user values are returned.
            await manager.user.findFirst({ select: { id: true } });
          },
          { maxWait: 1_000, timeout: 2_000 },
        )
        .finally(() => {
          this.databaseCheck = undefined;
        });
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.databaseCheck,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Readiness deadline exceeded')),
            3_000,
          );
        }),
      ]);
      return { status: 'ok', checks: { database: 'up' } };
    } catch {
      // Do not expose connection strings, database errors, or exception causes.
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { database: 'down' },
        message: 'Application is not ready',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
