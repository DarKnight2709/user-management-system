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
        { emit: 'stdout', level: 'info' },
        { emit: 'stdout', level: 'warn' },
        { emit: 'stdout', level: 'error' },
      ],
    });

    // 4. Log queries: log all queries in development, and warn on slow queries (>100ms)
    (this as any).$on('query', (e: Prisma.QueryEvent) => {
      if (isDevelopment) {
        Logger.log(
          `Query: ${e.query} -- params: ${e.params} (${e.duration}ms)`,
          'PrismaService',
        );
      }

      if (e.duration >= 100) {
        Logger.warn(
          `⚠️ SLOW QUERY (${e.duration}ms): ${e.query} -- params: ${e.params}`,
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
        const isTransactionConflict =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034';

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
