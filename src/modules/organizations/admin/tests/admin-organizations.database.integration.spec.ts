import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Prisma, PrismaClient } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { AdminOrganizationsService } from '../admin-organizations.service.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(runDatabaseTests)('Admin organizations database integration', () => {
  const schema = `admin_org_test_${randomUUID().replaceAll('-', '')}`;
  let ddl: pg.Client;
  let db: PrismaClient;
  let actorId: string;
  let organizationId: string;
  let platformRoleId: string;

  const createService = () => {
    const host = {
      async $transaction<T>(
        operation: (manager: Prisma.TransactionClient) => Promise<T>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) {
        return db.$transaction((manager) => operation(manager), options);
      },
      serializableTransaction<T>(
        operation: (manager: Prisma.TransactionClient) => Promise<T>,
      ) {
        return PrismaService.prototype.serializableTransaction.call(
          this,
          operation,
        ) as Promise<T>;
      },
    } as unknown as PrismaService;
    const permissions = new PermissionsService(host);
    const logging = {
      audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
      publishCommittedAudit: vi.fn(),
    };

    return {
      service: new AdminOrganizationsService(
        host,
        permissions,
        logging as unknown as LoggingService,
      ),
      logging,
    };
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const hostname = new URL(databaseUrl).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      throw new Error('Admin organization tests require local PostgreSQL');
    }

    ddl = new pg.Client({ connectionString: databaseUrl });
    await ddl.connect();
    await ddl.query(`CREATE SCHEMA "${schema}"`);
    await ddl.query(`SET search_path TO "${schema}"`);
    const migrations = await readdir('prisma/migrations', {
      withFileTypes: true,
    });
    for (const migration of migrations
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const sql = await readFile(
        `prisma/migrations/${migration.name}/migration.sql`,
        'utf8',
      );
      if (/\bpublic\s*\./i.test(sql)) {
        throw new Error('Migration explicitly targets application schema');
      }
      await ddl.query(sql);
    }
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
  }, 30_000);

  beforeEach(async () => {
    await db.rolePermission.deleteMany();
    await db.userPlatformRole.deleteMany();
    await db.permission.deleteMany();
    await db.role.deleteMany();
    await db.organization.deleteMany();
    await db.user.deleteMany();

    const actor = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        username: randomUUID(),
        firstName: 'Platform',
        lastName: 'Admin',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });
    actorId = actor.id;
    const organization = await db.organization.create({
      data: {
        name: 'Admin Test Organization',
        slug: randomUUID(),
        ownerId: actorId,
      },
    });
    organizationId = organization.id;

    const permission = await db.permission.create({
      data: { resource: 'ORGANIZATION', action: 'read' },
    });
    const updatePermission = await db.permission.create({
      data: { resource: 'ORGANIZATION', action: 'update' },
    });
    const role = await db.role.create({
      data: {
        name: 'SUPER_ADMIN',
        isSystem: true,
        rolePermissions: {
          create: [
            { permissionId: permission.id },
            { permissionId: updatePermission.id },
          ],
        },
      },
    });
    platformRoleId = role.id;
    await db.userPlatformRole.create({
      data: { userId: actorId, roleId: platformRoleId },
    });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ddl?.end();
  });

  it('lists active organizations from PostgreSQL with derived status', async () => {
    const { service } = createService();

    const result = await service.list(actorId, { page: 1, limit: 20 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: organizationId,
      status: 'ACTIVE',
    });
    expect(result.total).toBe(1);
  });

  it('filters organizations by status and search in PostgreSQL', async () => {
    await db.organization.create({
      data: {
        name: 'Suspended Organization',
        slug: 'suspended-organization',
        ownerId: actorId,
        isActive: false,
      },
    });
    const { service } = createService();

    const result = await service.list(actorId, {
      page: 1,
      limit: 20,
      search: 'suspended',
      status: 'SUSPENDED',
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      name: 'Suspended Organization',
      status: 'SUSPENDED',
    });
  });

  it('persists a suspension and its audit event through the transaction', async () => {
    const { service, logging } = createService();

    const result = await service.updateStatus(
      actorId,
      organizationId,
      'SUSPENDED',
    );
    const organization = await db.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });

    expect(result.status).toBe('SUSPENDED');
    expect(organization.isActive).toBe(false);
    expect(logging.audit).toHaveBeenCalledOnce();
    expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
  });

  it('does not create an audit event for an unchanged status', async () => {
    const { service, logging } = createService();

    await service.updateStatus(actorId, organizationId, 'ACTIVE');

    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    await expect(
      db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
    ).resolves.toMatchObject({ isActive: true });
  });

  it('rejects reactivation of a deleted organization', async () => {
    await db.organization.update({
      where: { id: organizationId },
      data: { deletedAt: new Date(), isActive: false },
    });
    const { service } = createService();

    await expect(
      service.updateStatus(actorId, organizationId, 'ACTIVE'),
    ).rejects.toMatchObject({ status: 409 });
  });
});
