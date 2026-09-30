import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, Prisma } from '@/generated/prisma/client.js';
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor() {
    const isDevelopment = process.env.NODE_ENV === 'development';
    const databaseUrl = process.env.DATABASE_URL;

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

  async onModuleInit() {
    await this.$connect();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
