import {
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';

@Injectable()
export class HealthService implements OnModuleDestroy {
  private databaseCheck?: Promise<void>;
  private shuttingDown = false;

  constructor(private readonly prisma: PrismaService) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new ServiceUnavailableException({
        status: 'unavailable',
        message: 'Application is shutting down',
      });
    }
  }

  async ready(): Promise<{ status: 'ok'; checks: { database: 'up' } }> {
    this.assertNotShuttingDown();
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
    } catch {
      this.assertNotShuttingDown();
      // Do not expose connection strings, database errors, or exception causes.
      throw new ServiceUnavailableException({
        status: 'unavailable',
        checks: { database: 'down' },
        message: 'Application is not ready',
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.assertNotShuttingDown();
    return { status: 'ok', checks: { database: 'up' } };
  }
}
