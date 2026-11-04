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
import { LoggingService } from '@/modules/logging/logging.service.js';
import { OrganizationOwnershipService } from '../organization-ownership.service.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(runDatabaseTests)(
  'Organization ownership database integration',
  () => {
    const schema = `organization_ownership_test_${randomUUID().replaceAll('-', '')}`;
    let ddl: pg.Client;
    let db: PrismaClient;
    let ownerId: string;
    let memberId: string;
    let organizationId: string;
    let ownerMembershipId: string;
    let memberMembershipId: string;
    let memberRoleId: string;

    const createHost = () => {
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
    };

    const createUser = (label: string) =>
      db.user.create({
        data: {
          email: `${label}-${randomUUID()}@example.com`,
          username: `${label}-${randomUUID()}`,
          firstName: label,
          lastName: 'Fixture',
          birthDate: new Date('2000-01-01'),
          hashedPassword: 'fixture',
        },
      });

    const createService = () =>
      new OrganizationOwnershipService(createHost(), {
        audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
        publishCommittedAudit: vi.fn(),
      } as unknown as LoggingService);

    beforeAll(async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is required');
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(databaseUrl).hostname,
        )
      ) {
        throw new Error('Ownership integration tests require local PostgreSQL');
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
        if (/\bpublic\s*\./i.test(sql))
          throw new Error('Migration explicitly targets application schema');
        await ddl.query(sql);
      }
      db = new PrismaClient({
        adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
      });
    }, 30_000);

    beforeEach(async () => {
      await db.$transaction([
        db.memberRole.deleteMany(),
        db.rolePermission.deleteMany(),
        db.role.deleteMany(),
        db.organizationMember.deleteMany(),
        db.organization.deleteMany(),
        db.permission.deleteMany(),
        db.user.deleteMany(),
      ]);

      const owner = await createUser('owner');
      const member = await createUser('member');
      ownerId = owner.id;
      memberId = member.id;

      const organization = await db.organization.create({
        data: {
          name: 'Ownership Integration',
          slug: `ownership-${randomUUID()}`,
          ownerId,
        },
      });
      organizationId = organization.id;

      const memberRole = await db.role.create({
        data: {
          organizationId,
          name: 'MEMBER',
          isSystem: false,
        },
      });
      memberRoleId = memberRole.id;
      await db.role.create({
        data: {
          organizationId,
          name: 'ADMIN',
          isSystem: false,
        },
      });

      const ownerMembership = await db.organizationMember.create({
        data: { organizationId, userId: ownerId },
      });
      const memberMembership = await db.organizationMember.create({
        data: {
          organizationId,
          userId: memberId,
          memberRoles: { create: { roleId: memberRoleId } },
        },
      });
      ownerMembershipId = ownerMembership.id;
      memberMembershipId = memberMembership.id;
    });

    afterAll(async () => {
      await db?.$disconnect();
      await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await ddl?.end();
    });

    it('transfers ownership and restores MEMBER for the former owner', async () => {
      const service = createService();

      await expect(
        service.transferForActor(ownerId, organizationId, memberMembershipId),
      ).resolves.toMatchObject({
        id: organizationId,
        ownerId: memberId,
        previousOwnerId: ownerId,
      });

      await expect(
        db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      ).resolves.toMatchObject({ ownerId: memberId });
      await expect(
        db.memberRole.findUnique({
          where: {
            organizationMemberId_roleId: {
              organizationMemberId: ownerMembershipId,
              roleId: memberRoleId,
            },
          },
        }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('publishes the audit event only after the transaction commits', async () => {
      const logging = {
        audit: vi.fn().mockResolvedValue({ eventId: 'audit-id' }),
        publishCommittedAudit: vi.fn(),
      };
      const service = new OrganizationOwnershipService(
        createHost(),
        logging as unknown as LoggingService,
      );

      await service.transferForActor(
        ownerId,
        organizationId,
        memberMembershipId,
      );

      expect(logging.audit).toHaveBeenCalledOnce();
      expect(logging.publishCommittedAudit).toHaveBeenCalledWith({
        eventId: 'audit-id',
      });
    });

    it('rejects unauthenticated callers and non-owner callers', async () => {
      const service = createService();

      await expect(
        service.transferForActor(
          randomUUID(),
          organizationId,
          memberMembershipId,
        ),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        service.transferForActor(memberId, organizationId, ownerMembershipId),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects invalid recipients without changing ownership', async () => {
      const service = createService();

      await expect(
        service.transferForActor(ownerId, organizationId, ownerMembershipId),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        service.transferForActor(ownerId, organizationId, randomUUID()),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      ).resolves.toMatchObject({ ownerId });
    });

    it('rolls back when the MEMBER role is unavailable', async () => {
      await db.role.update({
        where: { id: memberRoleId },
        data: { deletedAt: new Date() },
      });

      await expect(
        createService().transferForActor(
          ownerId,
          organizationId,
          memberMembershipId,
        ),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      ).resolves.toMatchObject({ ownerId });
    });
  },
);
