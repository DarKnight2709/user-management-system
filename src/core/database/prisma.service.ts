import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, Prisma } from '@/generated/prisma/client.js';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(private readonly configService: ConfigService) {
    const isDevelopment =
      configService.get<string>('NODE_ENV') === 'development';
    const databaseUrl = configService.get<string>('DATABASE_URL');

    if (!databaseUrl) {
      throw new Error(
        'DATABASE_URL is not defined in environment variables. Ensure .env is loaded.',
      );
    }

    // 1. Setup the native driver pool
    const pool = new Pool({ connectionString: databaseUrl });

    // 2. Wrap it in the Prisma Adapter
    const adapter = new PrismaPg(pool);

    // 3. Pass the adapter to the parent PrismaClient
    super({
      adapter,
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });

    // Never forward raw driver messages or metadata; they may contain sensitive data.
    (this as any).$on('info', () => {
      Logger.log(
        { message: 'Database information event', event: 'database.info' },
        'PrismaService',
      );
    });
    (this as any).$on('warn', () => {
      Logger.warn(
        { message: 'Database warning', event: 'database.warning' },
        'PrismaService',
      );
    });
    (this as any).$on('error', () => {
      Logger.error(
        { message: 'Database error event', event: 'database.error' },
        undefined,
        'PrismaService',
      );
    });

    // Log query metadata only; slow queries (>=100ms) warn in every environment.
    (this as any).$on('query', (e: Prisma.QueryEvent) => {
      const logDatabaseQueries =
        isDevelopment &&
        configService.get<boolean>('LOG_DATABASE_QUERIES') === true;

      const isSlowQuery = e.duration >= 100;

      if (!logDatabaseQueries && !isSlowQuery) {
        return;
      }

      const queryFingerprint = createHash('sha256')
        .update(e.query)
        .digest('hex');

      if (logDatabaseQueries) {
        Logger.debug(
          {
            message: 'Database query completed',
            event: 'database_query',
            queryFingerprint,
            durationMs: e.duration,
          },
          'PrismaService',
        );
      }

      if (isSlowQuery) {
        Logger.warn(
          {
            message: 'Slow database query',
            event: 'slow_database_query',
            queryFingerprint,
            durationMs: e.duration,
            thresholdMs: 100,
          },
          'PrismaService',
        );
      }
    });
  }

  async serializableTransaction<T>(
    operation: (manager: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        // Commit-time conflicts can escape the pg adapter without Prisma's P2034 wrapper.
        const driverCause =
          error instanceof Error && error.name === 'DriverAdapterError'
            ? error.cause
            : undefined;
        const isDriverConflict =
          typeof driverCause === 'object' &&
          driverCause !== null &&
          'originalCode' in driverCause &&
          (driverCause.originalCode === '40001' ||
            driverCause.originalCode === '40P01');
        const isTransactionConflict =
          (error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2034') ||
          isDriverConflict;

        if (!isTransactionConflict || attempt >= maxAttempts) {
          throw error;
        }
      }
    }
  }

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
