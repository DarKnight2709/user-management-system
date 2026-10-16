import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { AdminSeedError, seedAdmin } from './seeds/admin.seed.js';
import { seedOrganizationPermissions } from './seeds/organization-permissions.seed.js';

const permissionsOnly = process.argv.includes('--organization-permissions');
const seedLabel = permissionsOnly ? 'Organization permission' : 'Admin';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new AdminSeedError('DATABASE_URL is required');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });
  try {
    if (permissionsOnly) {
      await seedOrganizationPermissions(prisma);
    } else {
      await seedAdmin(prisma);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // Avoid printing database errors that might include credentials or user data.
  if (error instanceof AdminSeedError) {
    console.error(`${seedLabel} seed failed: ${error.message}`);
  } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
    console.error(`${seedLabel} seed failed: database error ${error.code}`);
  } else {
    console.error(
      `${seedLabel} seed failed. Check database connectivity and seed configuration.`,
    );
  }
  process.exitCode = 1;
});
