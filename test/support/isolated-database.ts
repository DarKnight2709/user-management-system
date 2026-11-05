import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaService } from '../../src/core/database/prisma.service.js';

const LOCAL_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];
const MIGRATIONS_DIRECTORY = 'prisma/migrations';

export interface IsolatedDatabase {
  db: PrismaClient;
  prisma: PrismaService;
  dispose(): Promise<void>;
}

/**
 * Applies every checked-in migration into a uniquely named temporary schema on
 * local PostgreSQL so integration tests never touch application tables.
 */
export async function createIsolatedDatabase(
  label: string,
): Promise<IsolatedDatabase> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!LOCAL_HOSTNAMES.includes(new URL(databaseUrl).hostname)) {
    throw new Error(`${label} integration tests require local PostgreSQL`);
  }

  const schema = `${label}_test_${randomUUID().replaceAll('-', '')}`;
  const ddl = new pg.Client({ connectionString: databaseUrl });
  await ddl.connect();
  await ddl.query(`CREATE SCHEMA "${schema}"`);
  await ddl.query(`SET search_path TO "${schema}"`);
  await applyMigrations(ddl);

  const db = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
  });
  return {
    db,
    prisma: createSerializableHost(db),
    async dispose() {
      await db.$disconnect();
      await ddl.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await ddl.end();
    },
  };
}

async function applyMigrations(ddl: pg.Client): Promise<void> {
  const entries = await readdir(MIGRATIONS_DIRECTORY, { withFileTypes: true });
  const migrationNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  for (const name of migrationNames) {
    const sql = await readFile(
      `${MIGRATIONS_DIRECTORY}/${name}/migration.sql`,
      'utf8',
    );
    if (/\bpublic\s*\./i.test(sql))
      throw new Error('Migration explicitly targets application schema');
    await ddl.query(sql);
  }
}

function createSerializableHost(db: PrismaClient): PrismaService {
  const host = {
    serializableTransaction<T>(
      operation: (manager: Prisma.TransactionClient) => Promise<T>,
    ) {
      return PrismaService.prototype.serializableTransaction.call(
        { $transaction: db.$transaction.bind(db) },
        operation,
      ) as Promise<T>;
    },
  };
  return host as unknown as PrismaService;
}

export async function clearOrganizationTables(db: PrismaClient): Promise<void> {
  await db.$transaction([
    db.organizationInvitation.deleteMany(),
    db.memberRole.deleteMany(),
    db.rolePermission.deleteMany(),
    db.userPlatformRole.deleteMany(),
    db.role.deleteMany(),
    db.organizationMember.deleteMany(),
    db.organization.deleteMany(),
    db.permission.deleteMany(),
    db.user.deleteMany(),
  ]);
}

export function createFixtureUser(db: PrismaClient, label: string) {
  return db.user.create({
    data: {
      email: `${label}-${randomUUID()}@example.com`,
      username: `${label}-${randomUUID()}`,
      firstName: label,
      lastName: 'Fixture',
      birthDate: new Date('2000-01-01'),
      hashedPassword: 'fixture',
    },
  });
}
