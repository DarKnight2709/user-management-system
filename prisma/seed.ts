import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { AdminSeedError, seedAdmin } from './seeds/admin.seed.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new AdminSeedError('DATABASE_URL is required');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    await seedAdmin(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Avoid printing database errors that might include credentials or user data.
  if (error instanceof AdminSeedError) {
    console.error(`Admin seed failed: ${error.message}`);
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`Admin seed failed: database error ${error.code}`);
  } else {
    console.error(
      'Admin seed failed. Check database connectivity and bootstrap configuration.',
    );
  }
  process.exitCode = 1;
});
