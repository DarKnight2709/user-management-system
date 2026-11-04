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
import { OrganizationMembersService } from '../organization-members.service.js';
import { MemberRolesService } from '../member-roles.service.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(runDatabaseTests)(
  'Organization members database integration',
  () => {
    const schema = `organization_members_test_${randomUUID().replaceAll('-', '')}`;
    let ddl: pg.Client;
    let db: PrismaClient;
    let ownerId: string;
    let memberId: string;
    let organizationId: string;
    let membershipId: string;
    let roleId: string;

    const createHost = () => {
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

    const createServices = () => {
      const host = createHost();
      return {
        members: new OrganizationMembersService(
          host,
          new PermissionsService(host),
          {
            audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
            publishCommittedAudit: vi.fn(),
          } as unknown as LoggingService,
        ),
        roles: new MemberRolesService(host, new PermissionsService(host), {
          audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
          publishCommittedAudit: vi.fn(),
        } as unknown as LoggingService),
      };
    };

    beforeAll(async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl) throw new Error('DATABASE_URL is required');
      if (
        !['localhost', '127.0.0.1', '[::1]'].includes(
          new URL(databaseUrl).hostname,
        )
      ) {
        throw new Error('Member integration tests require local PostgreSQL');
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
      await db.memberRole.deleteMany();
      await db.organizationMember.deleteMany();
      await db.rolePermission.deleteMany();
      await db.role.deleteMany();
      await db.permission.deleteMany();
      await db.organization.deleteMany();
      await db.user.deleteMany();

      const owner = await createUser('owner');
      const member = await createUser('member');
      ownerId = owner.id;
      memberId = member.id;
      const organization = await db.organization.create({
        data: {
          name: 'Members Integration',
          slug: `members-${randomUUID()}`,
          ownerId,
        },
      });
      organizationId = organization.id;

      const readPermission = await db.permission.create({
        data: { resource: 'ORGANIZATION_MEMBER', action: 'read' },
      });
      const role = await db.role.create({
        data: {
          organizationId,
          name: 'EDITOR',
          rolePermissions: { create: { permissionId: readPermission.id } },
        },
      });
      roleId = role.id;
      await db.organizationMember.create({
        data: { userId: ownerId, organizationId },
      });
      const membership = await db.organizationMember.create({
        data: { userId: memberId, organizationId },
      });
      membershipId = membership.id;
    });

    afterAll(async () => {
      await db?.$disconnect();
      await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await ddl?.end();
    });

    it('lists active members from PostgreSQL and excludes deleted memberships', async () => {
      const { members } = createServices();

      const result = await members.findAllForActor({
        actorId: ownerId,
        organizationId,
        page: 1,
        limit: 20,
      });

      expect(result.items).toHaveLength(2);
      await db.organizationMember.update({
        where: { id: membershipId },
        data: { deletedAt: new Date() },
      });

      await expect(
        members.findAllForActor({
          actorId: ownerId,
          organizationId,
          page: 1,
          limit: 20,
        }),
      ).resolves.toMatchObject({ total: 1 });
    });

    it('removes a member idempotently and retains its roles and account', async () => {
      const { members, roles } = createServices();
      await roles.assignForActor(ownerId, organizationId, membershipId, roleId);

      await members.removeForActor(ownerId, organizationId, membershipId);
      const removed = await db.organizationMember.findUniqueOrThrow({
        where: { id: membershipId },
      });
      expect(removed.deletedAt).toBeInstanceOf(Date);

      await expect(
        members.removeForActor(ownerId, organizationId, membershipId),
      ).resolves.toBeUndefined();
      await expect(
        db.user.findUnique({ where: { id: memberId } }),
      ).resolves.toBeTruthy();
      await expect(
        db.memberRole.findUnique({
          where: {
            organizationMemberId_roleId: {
              organizationMemberId: membershipId,
              roleId,
            },
          },
        }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('assigns and revokes a role atomically in PostgreSQL', async () => {
      const { roles } = createServices();

      await roles.assignForActor(ownerId, organizationId, membershipId, roleId);
      await expect(
        db.memberRole.findUnique({
          where: {
            organizationMemberId_roleId: {
              organizationMemberId: membershipId,
              roleId,
            },
          },
        }),
      ).resolves.toMatchObject({ deletedAt: null });

      await roles.revokeForActor(ownerId, organizationId, membershipId, roleId);
      await expect(
        db.memberRole.findUnique({
          where: {
            organizationMemberId_roleId: {
              organizationMemberId: membershipId,
              roleId,
            },
          },
        }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });
  },
);
