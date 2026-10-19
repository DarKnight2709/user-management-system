import { OrganizationRolesService } from '../src/modules/organizations/roles/organization-roles.service.js';
import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import { PrismaService } from '../src/core/database/prisma.service.js';
import { PermissionsService } from '../src/common/services/permissions.service.js';
import { UsersService } from '../src/modules/users/users.service.js';
import { UsersController } from '../src/modules/users/users.controller.js';
import type { S3Service } from '../src/core/storage/s3.service.js';
import type { AvatarCleanupService } from '../src/modules/users/avatar-cleanup.service.js';
import { JwtStrategy } from '../src/modules/auth/strategies/jwt.strategy.js';
import { seedAdmin, AdminSeedError } from '../prisma/seeds/admin.seed.js';
import { compare } from '../src/common/utils/hash.util.js';
import { ListUsersQueryDto } from '../src/modules/users/dto/list-users-query.dto.js';
import { OrganizationsService } from '../src/modules/organizations/organizations.service.js';
import { seedOrganizationPermissions } from '../prisma/seeds/organization-permissions.seed.js';
import { OrganizationsController } from '../src/modules/organizations/organizations.controller.js';
import { PermissionsGuard } from '../src/common/guards/permissions.guard.js';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { ListOrganizationsQueryDto } from '../src/modules/organizations/dto/list-organizations-query.dto.js';
import { OrganizationMembersService } from '../src/modules/organizations/members/organization-members.service.js';
import { OrganizationMembersController } from '../src/modules/organizations/members/organization-members.controller.js';
import { ListOrganizationMembersQueryDto } from '../src/modules/organizations/members/dto/list-organization-members-query.dto.js';

// Explicit opt-in; all fixtures live in a disposable schema, never application tables.
describe.runIf(process.env.RUN_DATABASE_TESTS === 'true')(
  'User account policies: local PostgreSQL',
  () => {
    const schema = `codex_delete_test_${randomUUID().replaceAll('-', '')}`;
    let ddl: pg.Client | undefined;
    let created = false;
    let db: PrismaClient;
    let superId: string;
    let adminId: string;
    let regularId: string;
    let superRoleId: string;
    let adminRoleId: string;
    let permissionId: string;
    let conflicts: number;

    type Hook = (manager: Prisma.TransactionClient) => Prisma.TransactionClient;
    const service = (hook?: Hook) => {
      const host = {
        user: db.user,
        async $transaction<T>(
          operation: (manager: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) {
          try {
            return await db.$transaction(
              (manager) => operation(hook ? hook(manager) : manager),
              options,
            );
          } catch (error) {
            const cause = error instanceof Error ? error.cause : undefined;
            if (
              (error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2034') ||
              (typeof cause === 'object' &&
                cause !== null &&
                'originalCode' in cause &&
                ['40001', '40P01'].includes(String(cause.originalCode)))
            )
              conflicts++;
            throw error;
          }
        },
        serializableTransaction<T>(
          operation: (manager: Prisma.TransactionClient) => Promise<T>,
        ): Promise<T> {
          return PrismaService.prototype.serializableTransaction.call(
            this,
            operation,
          ) as Promise<T>;
        },
      };
      const prisma = host as unknown as PrismaService;
      return new UsersService(
        prisma,
        {
          getPublicUrl: (key: string | null | undefined) =>
            key ? `http://storage.invalid/avatars/${key}` : null,
        } as S3Service,
        {} as AvatarCleanupService,
        new PermissionsService(prisma),
      );
    };

    const createUser = async () => {
      const key = randomUUID();
      return db.user.create({
        data: {
          email: `${key}@example.com`,
          username: key,
          firstName: 'Fixture',
          lastName: 'Only',
          birthDate: new Date('2000-01-01'),
          hashedPassword: 'not-a-login-hash',
          avatarKey: `${key}.jpg`,
        },
      });
    };
    const deleteAs = (actorId: string, targetId: string) =>
      service().delete({ actorId, targetId });
    const expectDenied = async (
      actorId: string,
      targetId: string,
      status: number,
    ) => {
      await expect(deleteAs(actorId, targetId)).rejects.toMatchObject({
        status,
      });
      const target = await db.user.findUnique({ where: { id: targetId } });
      if (target) expect(target.deletedAt).toBeNull();
    };
    const refreshToken = (userId: string) =>
      db.refreshToken.create({
        data: {
          userId,
          familyId: randomUUID(),
          refreshTokenHash: randomUUID(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
    const seedConfig = async (id: string) => {
      const user = await db.user.findUniqueOrThrow({ where: { id } });
      for (const [key, value] of Object.entries({
        EMAIL: user.email,
        USERNAME: user.username,
        PASSWORD: randomUUID(),
        FIRST_NAME: 'Fixture',
        LAST_NAME: 'Only',
        BIRTH_DATE: '2000-01-01',
      }))
        vi.stubEnv(`SEED_ADMIN_${key}`, value);
    };

    beforeAll(async () => {
      const url = process.env.DATABASE_URL;
      if (
        !url ||
        !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)
      ) {
        throw new Error('Database tests require a local PostgreSQL URL');
      }
      if (!/^codex_delete_test_[a-f0-9]+$/.test(schema))
        throw new Error('Unsafe test schema');
      ddl = new pg.Client({ connectionString: url });
      await ddl.connect();
      await ddl.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await ddl.query(`SET search_path TO "${schema}"`);
      const entries = await readdir('prisma/migrations', {
        withFileTypes: true,
      });
      for (const entry of entries
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const sql = await readFile(
          `prisma/migrations/${entry.name}/migration.sql`,
          'utf8',
        );
        if (/\bpublic\s*\./i.test(sql))
          throw new Error('Migration explicitly targets application schema');
        await ddl.query(sql);
      }
      db = new PrismaClient({
        adapter: new PrismaPg({ connectionString: url }, { schema }),
      });
    }, 30_000);

    beforeEach(async () => {
      conflicts = 0;
      await db.$transaction([
        db.memberRole.deleteMany(),
        db.rolePermission.deleteMany(),
        db.userPlatformRole.deleteMany(),
        db.refreshToken.deleteMany(),
        db.organizationMember.deleteMany(),
        db.role.deleteMany(),
        db.organization.deleteMany(),
        db.permission.deleteMany(),
        db.user.deleteMany(),
      ]);
      const permissions = await Promise.all(
        ['read', 'delete'].map((action) =>
          db.permission.create({ data: { resource: 'USER', action } }),
        ),
      );
      permissionId = permissions.find(
        (permission) => permission.action === 'delete',
      )!.id;
      for (const name of ['SUPER_ADMIN', 'PLATFORM_ADMIN']) {
        const role = await db.role.create({
          data: {
            name,
            isSystem: true,
            rolePermissions: {
              create: permissions.map((permission) => ({
                permissionId: permission.id,
              })),
            },
          },
        });
        const user = await createUser();
        await db.userPlatformRole.create({
          data: { userId: user.id, roleId: role.id },
        });
        if (name === 'SUPER_ADMIN') {
          superId = user.id;
          superRoleId = role.id;
        } else {
          adminId = user.id;
          adminRoleId = role.id;
        }
      }
      regularId = (await createUser()).id;
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    afterAll(async () => {
      try {
        await db?.$disconnect();
      } finally {
        if (created && ddl && /^codex_delete_test_[a-f0-9]+$/.test(schema)) {
          await ddl.query('SET search_path TO public');
          await ddl.query(`DROP SCHEMA "${schema}" CASCADE`);
        }
        await ddl?.end();
      }
    });

    const organizations = () =>
      new OrganizationsService(
        {
          serializableTransaction<T>(
            operation: (manager: Prisma.TransactionClient) => Promise<T>,
          ): Promise<T> {
            return PrismaService.prototype.serializableTransaction.call(
              {
                $transaction: db.$transaction.bind(db),
              },
              operation,
            ) as Promise<T>;
          },
        } as PrismaService,
        new PermissionsService(db as unknown as PrismaService),
      );

    describe('Organization member directory', () => {
      let organizationId: string;
      let membershipId: string;
      let roleId: string;
      const members = () =>
        new OrganizationMembersService(
          {
            serializableTransaction<T>(
              operation: (manager: Prisma.TransactionClient) => Promise<T>,
            ): Promise<T> {
              return PrismaService.prototype.serializableTransaction.call(
                { $transaction: db.$transaction.bind(db) },
                operation,
              ) as Promise<T>;
            },
          } as PrismaService,
          new PermissionsService(db as unknown as PrismaService),
        );
      const list = (actorId = regularId, page = 1, limit = 20) =>
        members().findAllForActor({ actorId, organizationId, page, limit });
      beforeEach(async () => {
        await seedOrganizationPermissions(db);
        const org = await organizations().create(regularId, {
          name: 'Directory',
          slug: `directory-${randomUUID()}`,
        });
        organizationId = org.id;
        const role = await db.role.findFirstOrThrow({
          where: { organizationId, name: 'MEMBER' },
        });
        roleId = role.id;
        const member = await db.organizationMember.create({
          data: {
            userId: adminId,
            organizationId,
            memberRoles: { create: { roleId } },
          },
        });
        membershipId = member.id;
      });
      describe('Current organization permissions', () => {
        const current = (actorId = adminId, orgId = organizationId) =>
          organizations().currentPermissions(actorId, orgId);

        it('returns real permission IDs without role management permission requirements', async () => {
          const response = await current();
          expect(response).toHaveLength(3);
          expect(response.every((item) => typeof item.id === 'string')).toBe(
            true,
          );
          expect(response.every((item) => item.action === 'read')).toBe(true);
          const roleRead = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: {
                resource: 'ORGANIZATION_ROLE',
                action: 'read',
              },
            },
          });
          await db.rolePermission.updateMany({
            where: { roleId, permissionId: roleRead.id },
            data: { deletedAt: new Date() },
          });
          await expect(current()).resolves.toHaveLength(2);
        });

        it('returns only active catalog permissions with real IDs for the owner', async () => {
          const deletion = await db.permission.create({
            data: { resource: 'ORGANIZATION', action: 'delete' },
          });
          const response = await current(regularId);
          expect(response).toHaveLength(11);
          expect(response.every((item) => typeof item.id === 'string')).toBe(
            true,
          );
          expect(
            response.some(
              (item) =>
                item.resource === 'ORGANIZATION' &&
                ['delete', 'transfer-ownership'].includes(item.action),
            ),
          ).toBe(false);
          expect(response.some((item) => item.id === deletion.id)).toBe(false);
        });

        it('unions multiple roles without duplicates and excludes malformed scope and legacy owner grants', async () => {
          const other = await organizations().create(regularId, {
            name: 'Other',
            slug: `permissions-${randomUUID()}`,
          });
          const foreignAdmin = await db.role.findFirstOrThrow({
            where: { organizationId: other.id, name: 'ADMIN' },
          });
          const localAdmin = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          const legacyOwner = await db.role.create({
            data: { name: 'OWNER', organizationId },
          });
          const remove = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: {
                resource: 'ORGANIZATION_MEMBER',
                action: 'remove',
              },
            },
          });
          await db.rolePermission.create({
            data: { roleId: legacyOwner.id, permissionId: remove.id },
          });
          await db.memberRole.createMany({
            data: [
              { organizationMemberId: membershipId, roleId: foreignAdmin.id },
              { organizationMemberId: membershipId, roleId: legacyOwner.id },
              { organizationMemberId: membershipId, roleId: superRoleId },
            ],
          });
          expect(await current()).toHaveLength(3);
          await db.memberRole.create({
            data: { organizationMemberId: membershipId, roleId: localAdmin.id },
          });
          const response = await current();
          expect(response).toHaveLength(6);
          expect(new Set(response.map((item) => item.id)).size).toBe(6);
          expect(
            response.some(
              (item) => item.id === null || item.resource === 'USER',
            ),
          ).toBe(false);
        });

        it.each(['assignment', 'role', 'grant', 'permission'])(
          'excludes a revoked %s',
          async (kind) => {
            const read = await db.permission.findUniqueOrThrow({
              where: {
                action_resource: { resource: 'ORGANIZATION', action: 'read' },
              },
            });
            if (kind === 'assignment')
              await db.memberRole.updateMany({
                where: { organizationMemberId: membershipId },
                data: { deletedAt: new Date() },
              });
            if (kind === 'role')
              await db.role.update({
                where: { id: roleId },
                data: { deletedAt: new Date() },
              });
            if (kind === 'grant')
              await db.rolePermission.updateMany({
                where: { roleId, permissionId: read.id },
                data: { deletedAt: new Date() },
              });
            if (kind === 'permission')
              await db.permission.update({
                where: { id: read.id },
                data: { deletedAt: new Date() },
              });
            expect((await current()).some((item) => item.id === read.id)).toBe(
              false,
            );
          },
        );

        it('allows a roleless active member to read an empty array', async () => {
          await db.memberRole.deleteMany({
            where: { organizationMemberId: membershipId },
          });
          await expect(current()).resolves.toEqual([]);
        });

        it('does not return ownership powers from legacy organization grants', async () => {
          const deletion = await db.permission.create({
            data: { resource: 'ORGANIZATION', action: 'delete' },
          });
          const transfer = await db.permission.create({
            data: { resource: 'ORGANIZATION', action: 'transfer-ownership' },
          });
          await db.rolePermission.createMany({
            data: [
              { roleId, permissionId: deletion.id },
              { roleId, permissionId: transfer.id },
            ],
          });
          expect(await current()).toHaveLength(3);
        });

        it.each([
          'membership removed',
          'membership suspended',
          'organization inactive',
          'organization deleted',
        ])('rejects %s', async (kind) => {
          if (kind === 'membership removed')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { deletedAt: new Date() },
            });
          if (kind === 'membership suspended')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { status: 'SUSPENDED' },
            });
          if (kind === 'organization inactive')
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
          if (kind === 'organization deleted')
            await db.organization.update({
              where: { id: organizationId },
              data: { deletedAt: new Date() },
            });
          await expect(current()).rejects.toMatchObject({ status: 403 });
        });

        it('denies outsiders and nonexistent organizations without platform bypass', async () => {
          await expect(current(superId)).rejects.toMatchObject({ status: 403 });
          await expect(current(adminId, randomUUID())).rejects.toMatchObject({
            status: 403,
          });
          await expect(current(randomUUID())).rejects.toMatchObject({
            status: 401,
          });
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
          await expect(current()).rejects.toMatchObject({ status: 401 });
        });
      });

      describe('Organization role reads', () => {
        const roles = () =>
          new OrganizationRolesService(
            {
              serializableTransaction<T>(
                operation: (manager: Prisma.TransactionClient) => Promise<T>,
              ): Promise<T> {
                return PrismaService.prototype.serializableTransaction.call(
                  { $transaction: db.$transaction.bind(db) },
                  operation,
                ) as Promise<T>;
              },
            } as PrismaService,
            new PermissionsService(db as unknown as PrismaService),
          );

        describe('Custom role updates', () => {
          const permission = (resource: string, action: string) =>
            db.permission.findUniqueOrThrow({
              where: { action_resource: { resource, action } },
            });
          const custom = async (permissionIds: string[] = []) =>
            roles().createForActor(regularId, organizationId, {
              name: 'EDITOR',
              permissionIds,
            });

          it('renames without changing grants and replaces grants without changing the name', async () => {
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const role = await custom([read.id]);
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                name: ' reviewer ',
              }),
            ).resolves.toMatchObject({
              name: 'REVIEWER',
              permissions: [{ id: read.id }],
            });
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                permissionIds: [invite.id],
              }),
            ).resolves.toMatchObject({
              name: 'REVIEWER',
              permissions: [{ id: invite.id }],
            });
            expect(
              await db.rolePermission.findUniqueOrThrow({
                where: {
                  roleId_permissionId: {
                    roleId: role.id,
                    permissionId: read.id,
                  },
                },
              }),
            ).toMatchObject({ deletedAt: expect.any(Date) });
            await roles().updateForActor(regularId, organizationId, role.id, {
              permissionIds: [read.id],
            });
            expect(
              await db.rolePermission.count({
                where: { roleId: role.id, permissionId: read.id },
              }),
            ).toBe(1);
            expect(
              await db.rolePermission.findUniqueOrThrow({
                where: {
                  roleId_permissionId: {
                    roleId: role.id,
                    permissionId: read.id,
                  },
                },
              }),
            ).toMatchObject({ deletedAt: null });
          });

          it('clears permissions and updates authorization for existing assignees', async () => {
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const role = await custom([invite.id]);
            await db.memberRole.create({
              data: { organizationMemberId: membershipId, roleId: role.id },
            });
            const permissions = new PermissionsService(
              db as unknown as PrismaService,
            );
            expect(
              await permissions.hasOrganizationPermissions(
                adminId,
                organizationId,
                [invite],
              ),
            ).toBe(true);
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                permissionIds: [],
              }),
            ).resolves.toMatchObject({ permissions: [] });
            expect(
              await permissions.hasOrganizationPermissions(
                adminId,
                organizationId,
                [invite],
              ),
            ).toBe(false);
            expect(
              await db.memberRole.count({ where: { roleId: role.id } }),
            ).toBe(1);
          });

          it('denies non-editors and inactive actors', async () => {
            const role = await custom();
            for (const actor of [adminId, superId])
              await expect(
                roles().updateForActor(actor, organizationId, role.id, {
                  name: 'DENIED',
                }),
              ).rejects.toMatchObject({ status: 403 });
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                name: 'DENIED',
              }),
            ).rejects.toMatchObject({ status: 401 });
          });

          it('protects built-in roles and excludes other organizations and deleted roles', async () => {
            await expect(
              roles().updateForActor(regularId, organizationId, roleId, {
                name: 'RENAMED',
              }),
            ).rejects.toMatchObject({ status: 403 });
            const admin = await db.role.findFirstOrThrow({
              where: { organizationId, name: 'ADMIN' },
            });
            await expect(
              roles().updateForActor(regularId, organizationId, admin.id, {
                permissionIds: [],
              }),
            ).rejects.toMatchObject({ status: 403 });
            const role = await custom();
            const other = await organizations().create(regularId, {
              name: 'Other',
              slug: `role-update-${randomUUID()}`,
            });
            await expect(
              roles().updateForActor(regularId, other.id, role.id, {
                name: 'WRONG_SCOPE',
              }),
            ).rejects.toMatchObject({ status: 404 });
            await db.role.update({
              where: { id: role.id },
              data: { deletedAt: new Date() },
            });
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                name: 'REMOVED',
              }),
            ).rejects.toMatchObject({ status: 404 });
          });

          it('rejects empty, null, reserved and duplicate names on direct service calls', async () => {
            const role = await custom();
            for (const input of [
              {},
              { name: null },
              { permissionIds: null },
              { name: 'admin' },
            ]) {
              await expect(
                roles().updateForActor(
                  regularId,
                  organizationId,
                  role.id,
                  input as never,
                ),
              ).rejects.toMatchObject({ status: 422 });
            }
            await roles().createForActor(regularId, organizationId, {
              name: 'RESERVED',
              permissionIds: [],
            });
            await expect(
              roles().updateForActor(regularId, organizationId, role.id, {
                name: 'reserved',
              }),
            ).rejects.toMatchObject({ status: 409 });
          });

          it('does not partially rename when a permission selection is invalid', async () => {
            const role = await custom();
            for (const id of [randomUUID(), permissionId]) {
              await expect(
                roles().updateForActor(regularId, organizationId, role.id, {
                  name: 'PARTIAL',
                  permissionIds: [id],
                }),
              ).rejects.toMatchObject({ status: 422 });
            }
            expect(
              await db.role.findUniqueOrThrow({ where: { id: role.id } }),
            ).toMatchObject({ name: 'EDITOR' });
          });

          it('checks both current and replacement permissions before allowing delegation', async () => {
            const update = await permission('ORGANIZATION_ROLE', 'update');
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            await db.rolePermission.create({
              data: { roleId, permissionId: update.id },
            });
            const strongRole = await custom([invite.id]);
            await expect(
              roles().updateForActor(adminId, organizationId, strongRole.id, {
                permissionIds: [],
              }),
            ).rejects.toMatchObject({ status: 403 });
            await expect(
              roles().updateForActor(adminId, organizationId, strongRole.id, {
                name: 'STRONG',
              }),
            ).rejects.toMatchObject({ status: 403 });
            const weakRole = await roles().createForActor(
              regularId,
              organizationId,
              { name: 'WEAK', permissionIds: [read.id] },
            );
            await expect(
              roles().updateForActor(adminId, organizationId, weakRole.id, {
                permissionIds: [invite.id],
              }),
            ).rejects.toMatchObject({ status: 403 });
            await expect(
              roles().updateForActor(adminId, organizationId, weakRole.id, {
                name: 'ALLOWED',
              }),
            ).resolves.toMatchObject({ name: 'ALLOWED' });
          });

          it('serializes concurrent permission replacements without merging them', async () => {
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const role = await custom();
            await Promise.all([
              roles().updateForActor(regularId, organizationId, role.id, {
                permissionIds: [read.id],
              }),
              roles().updateForActor(regularId, organizationId, role.id, {
                permissionIds: [invite.id],
              }),
            ]);
            const active = await db.rolePermission.findMany({
              where: { roleId: role.id, deletedAt: null },
            });
            expect(active).toHaveLength(1);
            expect([read.id, invite.id]).toContain(active[0].permissionId);
          });
        });

        describe('Custom role creation', () => {
          const permission = (resource: string, action: string) =>
            db.permission.findUniqueOrThrow({
              where: { action_resource: { resource, action } },
            });
          const create = (
            actorId = regularId,
            name = 'MODERATOR',
            permissionIds: string[] = [],
          ) =>
            roles().createForActor(actorId, organizationId, {
              name,
              permissionIds,
            });

          it('creates a scoped custom role and permission links atomically without assignments', async () => {
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            const result = await create(regularId, ' moderator ', [read.id]);
            expect(result).toMatchObject({
              name: 'MODERATOR',
              isBuiltIn: false,
              permissions: [{ id: read.id }],
            });
            expect(
              await db.role.findUniqueOrThrow({ where: { id: result.id } }),
            ).toMatchObject({ organizationId, isSystem: false });
            expect(
              await db.rolePermission.count({ where: { roleId: result.id } }),
            ).toBe(1);
            expect(
              await db.memberRole.count({ where: { roleId: result.id } }),
            ).toBe(0);
          });

          it('denies ordinary members, built-in admins and platform admins without create permission', async () => {
            for (const actor of [adminId, superId])
              await expect(create(actor)).rejects.toMatchObject({
                status: 403,
              });
            const admin = await db.role.findFirstOrThrow({
              where: { organizationId, name: 'ADMIN' },
            });
            await db.memberRole.create({
              data: { organizationMemberId: membershipId, roleId: admin.id },
            });
            await expect(create(adminId)).rejects.toMatchObject({
              status: 403,
            });
          });

          it('enforces delegation against current permissions', async () => {
            const canCreate = await permission('ORGANIZATION_ROLE', 'create');
            await db.rolePermission.create({
              data: { roleId, permissionId: canCreate.id },
            });
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            await expect(
              create(adminId, 'READER', [read.id]),
            ).resolves.toMatchObject({ name: 'READER' });
            const remove = await permission('ORGANIZATION_MEMBER', 'remove');
            await expect(
              create(adminId, 'ESCALATION', [remove.id]),
            ).rejects.toMatchObject({ status: 403 });
            expect(
              await db.role.count({
                where: { organizationId, name: 'ESCALATION' },
              }),
            ).toBe(0);
          });

          it.each(['delete', 'transfer-ownership'])(
            'rejects legacy organization %s outside the role catalog',
            async (action) => {
              const selected = await db.permission.create({
                data: {
                  resource: 'ORGANIZATION',
                  action,
                  description: 'Legacy permission',
                },
              });
              await expect(
                create(regularId, 'OWNER_POWER', [selected.id]),
              ).rejects.toMatchObject({ status: 422 });
            },
          );

          it('keeps platform deletion separate and hides legacy owner-only grants', async () => {
            const deletion = await db.permission.create({
              data: {
                resource: 'ORGANIZATION',
                action: 'delete',
                description: 'Delete organizations across the application',
              },
            });
            const transfer = await db.permission.create({
              data: { resource: 'ORGANIZATION', action: 'transfer-ownership' },
            });
            await db.rolePermission.createMany({
              data: [
                { roleId, permissionId: deletion.id },
                { roleId, permissionId: transfer.id },
                { roleId: superRoleId, permissionId: deletion.id },
              ],
            });
            await seedOrganizationPermissions(db);
            const catalog = await roles().catalogForActor(
              regularId,
              organizationId,
            );
            expect(catalog).toHaveLength(11);
            expect(
              catalog.some((p) => [deletion.id, transfer.id].includes(p.id)),
            ).toBe(false);
            const listed = await roles().listForActor(
              regularId,
              organizationId,
              {},
            );
            expect(
              listed.items
                .flatMap((role) => role.permissions)
                .some((p) => [deletion.id, transfer.id].includes(p.id)),
            ).toBe(false);
            expect(
              (
                await db.permission.findUniqueOrThrow({
                  where: { id: deletion.id },
                })
              ).description,
            ).toBe('Delete organizations across the application');
            expect(
              await new PermissionsService(
                db as unknown as PrismaService,
              ).hasPlatformPermission(superId, {
                resource: 'ORGANIZATION',
                action: 'delete',
              }),
            ).toBe(true);
          });

          it('rejects inactive, unknown and platform permissions without partial creation', async () => {
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            await db.permission.update({
              where: { id: read.id },
              data: { deletedAt: new Date() },
            });
            for (const id of [read.id, randomUUID(), permissionId]) {
              await expect(
                create(regularId, 'INVALID', [id]),
              ).rejects.toMatchObject({ status: 422 });
            }
            expect(
              await db.role.count({
                where: { organizationId, name: 'INVALID' },
              }),
            ).toBe(0);
          });

          it('reserves built-in and deleted names and permits the same name in another organization', async () => {
            for (const name of [' admin ', 'MEMBER', 'owner'])
              await expect(create(regularId, name)).rejects.toMatchObject({
                status: 422,
              });
            const existing = await create();
            await db.role.update({
              where: { id: existing.id },
              data: { deletedAt: new Date() },
            });
            await expect(create(regularId, 'moderator')).rejects.toMatchObject({
              status: 409,
            });
            const other = await organizations().create(regularId, {
              name: 'Other',
              slug: `role-create-${randomUUID()}`,
            });
            await expect(
              roles().createForActor(regularId, other.id, {
                name: 'MODERATOR',
                permissionIds: [],
              }),
            ).resolves.toMatchObject({ name: 'MODERATOR' });
          });

          it('creates exactly one role under concurrent duplicate requests', async () => {
            const results = await Promise.allSettled([create(), create()]);
            expect(
              results.filter((result) => result.status === 'fulfilled'),
            ).toHaveLength(1);
            const failed = results.find(
              (result) => result.status === 'rejected',
            );
            expect(
              failed?.status === 'rejected' && failed.reason,
            ).toMatchObject({ status: 409 });
            expect(
              await db.role.count({
                where: { organizationId, name: 'MODERATOR' },
              }),
            ).toBe(1);
          });

          it('rejects removed owners, inactive organizations and deleted accounts', async () => {
            const ownerMembership =
              await db.organizationMember.findUniqueOrThrow({
                where: {
                  organizationId_userId: { organizationId, userId: regularId },
                },
              });
            await db.organizationMember.update({
              where: { id: ownerMembership.id },
              data: { status: 'SUSPENDED' },
            });
            await expect(create()).rejects.toMatchObject({ status: 403 });
            await db.organizationMember.update({
              where: { id: ownerMembership.id },
              data: { status: 'ACTIVE' },
            });
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
            await expect(create()).rejects.toMatchObject({ status: 403 });
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
            await expect(create()).rejects.toMatchObject({ status: 401 });
          });
        });

        it.each(['owner', 'member'])(
          'lists local roles and active permissions for %s',
          async (actor) => {
            const response = await roles().listForActor(
              actor === 'owner' ? regularId : adminId,
              organizationId,
              {},
            );
            expect(response).toMatchObject({ total: 2, page: 1, limit: 20 });
            expect(response.items.map((role) => role.name)).toEqual([
              'ADMIN',
              'MEMBER',
            ]);
            expect(response.items.every((role) => role.isBuiltIn)).toBe(true);
            expect(
              response.items.find((role) => role.name === 'ADMIN')?.permissions,
            ).toHaveLength(6);
            expect(
              response.items.find((role) => role.name === 'MEMBER')
                ?.permissions,
            ).toHaveLength(3);
          },
        );

        it('excludes platform/unknown permissions and roles from other organizations', async () => {
          await organizations().create(regularId, {
            name: 'Other',
            slug: `roles-${randomUUID()}`,
          });
          await db.rolePermission.create({ data: { roleId, permissionId } });
          const unknown = await db.permission.create({
            data: { resource: 'ORGANIZATION_ROLE', action: 'unknown' },
          });
          await db.rolePermission.create({
            data: { roleId, permissionId: unknown.id },
          });
          const response = await roles().listForActor(adminId, organizationId, {
            page: 1,
            limit: 1,
          });
          expect(response).toMatchObject({ total: 2, limit: 1 });
          expect(response.items).toHaveLength(1);
          const catalog = await roles().catalogForActor(
            adminId,
            organizationId,
          );
          expect(catalog).toHaveLength(11);
          expect(
            catalog.some(
              (permission) =>
                permission.resource === 'USER' ||
                permission.action === 'unknown',
            ),
          ).toBe(false);
          const member = await roles().listForActor(adminId, organizationId, {
            page: 2,
            limit: 1,
          });
          expect(member.items[0].permissions).toHaveLength(3);
        });

        it('excludes deleted roles, grants and catalog permissions', async () => {
          const read = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: { action: 'read', resource: 'ORGANIZATION' },
            },
          });
          await db.rolePermission.updateMany({
            where: { roleId, permissionId: read.id },
            data: { deletedAt: new Date() },
          });
          const invite = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: {
                action: 'invite',
                resource: 'ORGANIZATION_MEMBER',
              },
            },
          });
          await db.permission.update({
            where: { id: invite.id },
            data: { deletedAt: new Date() },
          });
          const custom = await db.role.create({
            data: { organizationId, name: 'ARCHIVED', deletedAt: new Date() },
          });
          const response = await roles().listForActor(
            adminId,
            organizationId,
            {},
          );
          expect(response.total).toBe(2);
          expect(response.items.some((role) => role.id === custom.id)).toBe(
            false,
          );
          expect(
            response.items
              .find((role) => role.name === 'MEMBER')
              ?.permissions.some((permission) => permission.id === read.id),
          ).toBe(false);
          expect(
            (await roles().catalogForActor(adminId, organizationId)).some(
              (permission) => permission.id === invite.id,
            ),
          ).toBe(false);
        });

        it('denies platform administrators and revoked organization read permission', async () => {
          await expect(
            roles().listForActor(superId, organizationId, {}),
          ).rejects.toMatchObject({ status: 403 });
          const read = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: {
                action: 'read',
                resource: 'ORGANIZATION_ROLE',
              },
            },
          });
          await db.rolePermission.updateMany({
            where: { roleId, permissionId: read.id },
            data: { deletedAt: new Date() },
          });
          await expect(
            roles().catalogForActor(adminId, organizationId),
          ).rejects.toMatchObject({ status: 403 });
        });

        it('denies removed membership, inactive organization and deleted actor', async () => {
          await db.organizationMember.update({
            where: { id: membershipId },
            data: { deletedAt: new Date() },
          });
          await expect(
            roles().catalogForActor(adminId, organizationId),
          ).rejects.toMatchObject({ status: 403 });
          await db.organization.update({
            where: { id: organizationId },
            data: { isActive: false },
          });
          await expect(
            roles().listForActor(regularId, organizationId, {}),
          ).rejects.toMatchObject({ status: 403 });
          await db.user.update({
            where: { id: regularId },
            data: { deletedAt: new Date() },
          });
          await expect(
            roles().listForActor(regularId, organizationId, {}),
          ).rejects.toMatchObject({ status: 401 });
        });

        it('validates pagination even for direct service calls', async () => {
          await expect(
            roles().listForActor(adminId, organizationId, { limit: 101 }),
          ).rejects.toMatchObject({ status: 422 });
        });
      });

      describe('Member removal', () => {
        const remove = (actorId = regularId, targetId = membershipId) =>
          members().removeForActor(actorId, organizationId, targetId);

        it('lets the owner remove a member, retains history and ends organization access', async () => {
          const token = await refreshToken(adminId);
          await remove();
          expect(
            (
              await db.organizationMember.findUniqueOrThrow({
                where: { id: membershipId },
              })
            ).deletedAt,
          ).toBeInstanceOf(Date);
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: membershipId },
            }),
          ).toBe(1);
          expect(
            await db.user.findUniqueOrThrow({ where: { id: adminId } }),
          ).toMatchObject({ deletedAt: null });
          expect(
            await db.refreshToken.findUniqueOrThrow({
              where: { id: token.id },
            }),
          ).toMatchObject({ revokedAt: null });
          await expect(list(adminId)).rejects.toMatchObject({ status: 403 });
          expect(await list()).toMatchObject({ total: 1 });
        });

        it('denies ordinary members and platform administrators without organization permission', async () => {
          for (const actor of [adminId, superId]) {
            await expect(remove(actor)).rejects.toMatchObject({ status: 403 });
          }
        });

        it('rejects deleted actors', async () => {
          await db.user.update({
            where: { id: regularId },
            data: { deletedAt: new Date() },
          });
          await expect(remove()).rejects.toMatchObject({ status: 401 });
        });

        it('does not remove the owner', async () => {
          const owner = await db.organizationMember.findUniqueOrThrow({
            where: {
              organizationId_userId: { organizationId, userId: regularId },
            },
          });
          await expect(remove(regularId, owner.id)).rejects.toMatchObject({
            status: 409,
          });
        });

        it('does not expose or remove another organization membership', async () => {
          const other = await organizations().create(regularId, {
            name: 'Other',
            slug: `other-${randomUUID()}`,
          });
          const target = await db.organizationMember.findUniqueOrThrow({
            where: {
              organizationId_userId: {
                organizationId: other.id,
                userId: regularId,
              },
            },
          });
          await expect(remove(regularId, target.id)).rejects.toMatchObject({
            status: 404,
          });
          await expect(remove(regularId, randomUUID())).rejects.toMatchObject({
            status: 404,
          });
        });

        it.each(['ADMIN', 'CUSTOM'])(
          'applies the owner/admin hierarchy to a %s role holder',
          async (name) => {
            const adminRole = await db.role.findFirstOrThrow({
              where: { organizationId, name: 'ADMIN' },
            });
            await db.memberRole.create({
              data: {
                organizationMemberId: membershipId,
                roleId: adminRole.id,
              },
            });
            const targetUser = await createUser();
            const targetRole =
              name === 'ADMIN'
                ? adminRole
                : await db.role.create({ data: { organizationId, name } });
            const target = await db.organizationMember.create({
              data: {
                organizationId,
                userId: targetUser.id,
                memberRoles: { create: { roleId: targetRole.id } },
              },
            });
            if (name === 'ADMIN') {
              await expect(remove(adminId, target.id)).rejects.toMatchObject({
                status: 403,
              });
            } else {
              await expect(remove(adminId, target.id)).resolves.toBeUndefined();
            }
            await expect(remove(regularId, target.id)).resolves.toBeUndefined();
          },
        );

        it('requires remove permission and limits custom roles to ordinary members', async () => {
          const permission = await db.permission.findUniqueOrThrow({
            where: {
              action_resource: {
                action: 'remove',
                resource: 'ORGANIZATION_MEMBER',
              },
            },
          });
          const customRole = await db.role.create({
            data: { organizationId, name: 'MODERATOR' },
          });
          await db.memberRole.create({
            data: { organizationMemberId: membershipId, roleId: customRole.id },
          });
          const ordinary = await createUser();
          const ordinaryMember = await db.organizationMember.create({
            data: {
              organizationId,
              userId: ordinary.id,
              memberRoles: { create: { roleId } },
            },
          });
          await expect(
            remove(adminId, ordinaryMember.id),
          ).rejects.toMatchObject({ status: 403 });
          await db.rolePermission.create({
            data: { roleId: customRole.id, permissionId: permission.id },
          });
          const peer = await createUser();
          const peerMember = await db.organizationMember.create({
            data: {
              organizationId,
              userId: peer.id,
              memberRoles: { create: { roleId: customRole.id } },
            },
          });
          await expect(remove(adminId, peerMember.id)).rejects.toMatchObject({
            status: 403,
          });
          await expect(remove(adminId, membershipId)).rejects.toMatchObject({
            status: 403,
          });
          await expect(
            remove(adminId, ordinaryMember.id),
          ).resolves.toBeUndefined();
        });

        it('uses the highest active role and ignores revoked ADMIN assignments', async () => {
          const adminRole = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          const customRole = await db.role.create({
            data: { organizationId, name: 'HELPER' },
          });
          await db.memberRole.createMany({
            data: [
              { organizationMemberId: membershipId, roleId: adminRole.id },
              { organizationMemberId: membershipId, roleId: customRole.id },
            ],
          });
          const peer = await createUser();
          const peerMember = await db.organizationMember.create({
            data: {
              organizationId,
              userId: peer.id,
              memberRoles: { create: [{ roleId }, { roleId: adminRole.id }] },
            },
          });
          await expect(remove(adminId, peerMember.id)).rejects.toMatchObject({
            status: 403,
          });
          await db.memberRole.updateMany({
            where: {
              organizationMemberId: peerMember.id,
              roleId: adminRole.id,
            },
            data: { deletedAt: new Date() },
          });
          await expect(remove(adminId, peerMember.id)).resolves.toBeUndefined();
        });

        it('lets an organization admin remove an ordinary member', async () => {
          const adminRole = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          await db.memberRole.create({
            data: { organizationMemberId: membershipId, roleId: adminRole.id },
          });
          const targetUser = await createUser();
          const target = await db.organizationMember.create({
            data: {
              organizationId,
              userId: targetUser.id,
              memberRoles: { create: { roleId } },
            },
          });
          await expect(remove(adminId, target.id)).resolves.toBeUndefined();
          await expect(remove(adminId, membershipId)).rejects.toMatchObject({
            status: 403,
          });
        });

        it('makes authorized repeated and simultaneous removal idempotent', async () => {
          await Promise.all([remove(), remove()]);
          const first = await db.organizationMember.findUniqueOrThrow({
            where: { id: membershipId },
          });
          await remove();
          expect(
            (
              await db.organizationMember.findUniqueOrThrow({
                where: { id: membershipId },
              })
            ).deletedAt,
          ).toEqual(first.deletedAt);
        });
      });

      it.each(['owner', 'member'])(
        'allows %s and exposes only directory fields',
        async (actor) => {
          const result = await list(actor === 'owner' ? regularId : adminId);
          expect(result).toMatchObject({ total: 2, page: 1, limit: 20 });
          expect(result.items).toHaveLength(2);
          for (const item of result.items) {
            expect(Object.keys(item).sort()).toEqual(
              ['id', 'status', 'createdAt', 'user', 'isOwner', 'roles'].sort(),
            );
            expect(Object.keys(item.user).sort()).toEqual(
              ['id', 'username', 'firstName', 'lastName'].sort(),
            );
          }
          expect(
            result.items.find((item) => item.user.id === regularId),
          ).toMatchObject({ isOwner: true, roles: [] });
          expect(
            result.items.find((item) => item.user.id === adminId),
          ).toMatchObject({
            isOwner: false,
            roles: [{ id: roleId, name: 'MEMBER' }],
          });
        },
      );
      it('does not grant platform admins directory access', async () => {
        await expect(list(superId)).rejects.toMatchObject({ status: 403 });
      });
      it.each(['missing', 'deleted'])('rejects a %s actor', async (state) => {
        if (state === 'deleted')
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
        await expect(
          list(state === 'missing' ? randomUUID() : adminId),
        ).rejects.toMatchObject({ status: 401 });
      });
      it('requires member read rather than organization read alone', async () => {
        const permission = await db.permission.findUniqueOrThrow({
          where: {
            action_resource: {
              resource: 'ORGANIZATION_MEMBER',
              action: 'read',
            },
          },
        });
        await db.rolePermission.updateMany({
          where: { roleId, permissionId: permission.id },
          data: { deletedAt: new Date() },
        });
        await expect(
          organizations().findOneForActor(adminId, organizationId),
        ).resolves.toMatchObject({ id: organizationId });
        await expect(list(adminId)).rejects.toMatchObject({ status: 403 });
      });
      it.each([
        'inactive organization',
        'deleted organization',
        'suspended actor',
        'invited actor',
        'deleted membership',
        'assignment',
        'role',
        'permission',
      ])('denies directory access after %s', async (state) => {
        if (state === 'inactive organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { isActive: false },
          });
        if (state === 'deleted organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { deletedAt: new Date() },
          });
        if (state === 'suspended actor' || state === 'invited actor')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: {
              status: state === 'suspended actor' ? 'SUSPENDED' : 'INVITED',
            },
          });
        if (state === 'deleted membership')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'assignment')
          await db.memberRole.updateMany({
            where: { organizationMemberId: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'role')
          await db.role.update({
            where: { id: roleId },
            data: { deletedAt: new Date() },
          });
        if (state === 'permission')
          await db.permission.update({
            where: {
              action_resource: {
                resource: 'ORGANIZATION_MEMBER',
                action: 'read',
              },
            },
            data: { deletedAt: new Date() },
          });
        await expect(list(adminId)).rejects.toMatchObject({ status: 403 });
      });
      it.each(['SUSPENDED', 'INVITED', 'deleted membership', 'deleted user'])(
        'excludes %s from both directory and total',
        async (state) => {
          if (state === 'SUSPENDED' || state === 'INVITED')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { status: state },
            });
          if (state === 'deleted membership')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { deletedAt: new Date() },
            });
          if (state === 'deleted user')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          const result = await list();
          expect(result.total).toBe(1);
          expect(result.items.map((item) => item.user.id)).toEqual([regularId]);
        },
      );
      it('does not expose members or role labels from another organization', async () => {
        const other = await organizations().create(superId, {
          name: 'Other',
          slug: `other-${randomUUID()}`,
        });
        const role = await db.role.findFirstOrThrow({
          where: { organizationId: other.id, name: 'ADMIN' },
        });
        await db.memberRole.updateMany({
          where: { organizationMemberId: membershipId },
          data: { roleId: role.id },
        });
        const result = await list();
        expect(result.total).toBe(2);
        expect(result.items.map((item) => item.user.id)).not.toContain(superId);
        expect(
          result.items.find((item) => item.user.id === adminId)?.roles,
        ).toEqual([]);
        await expect(list(adminId)).rejects.toMatchObject({ status: 403 });
      });
      it.each(['assignment', 'deleted role', 'system role', 'legacy OWNER'])(
        'hides invalid role labels: %s',
        async (state) => {
          if (state === 'assignment')
            await db.memberRole.updateMany({
              where: { organizationMemberId: membershipId },
              data: { deletedAt: new Date() },
            });
          if (state === 'deleted role')
            await db.role.update({
              where: { id: roleId },
              data: { deletedAt: new Date() },
            });
          if (state === 'system role')
            await db.memberRole.updateMany({
              where: { organizationMemberId: membershipId },
              data: { roleId: superRoleId },
            });
          if (state === 'legacy OWNER')
            await db.role.update({
              where: { id: roleId },
              data: { name: 'OWNER' },
            });
          const result = await list();
          expect(
            result.items.find((item) => item.user.id === adminId)?.roles,
          ).toEqual([]);
        },
      );
      it('paginates without overlap or cross-organization counts', async () => {
        await organizations().create(superId, {
          name: 'Hidden',
          slug: `hidden-${randomUUID()}`,
        });
        await db.organizationMember.updateMany({
          data: { createdAt: new Date('2020-01-01') },
        });
        const ids: string[] = [];
        for (const page of [1, 2, 3]) {
          const result = await list(regularId, page, 1);
          expect(result).toMatchObject({ total: 2, page, limit: 1 });
          expect(result.items).toHaveLength(page <= 2 ? 1 : 0);
          ids.push(...result.items.map((item) => item.id));
        }
        expect(new Set(ids).size).toBe(2);
        expect(ids).toEqual([...ids].sort());
      });
      it.each([
        { page: 0 },
        { page: 1.5 },
        { page: 1_000_001 },
        { limit: 0 },
        { limit: 101 },
        { limit: NaN },
      ])('rejects invalid direct pagination %j', async (query) => {
        await expect(
          members().findAllForActor({
            actorId: regularId,
            organizationId,
            ...query,
          }),
        ).rejects.toMatchObject({ status: 422 });
      });
      it('returns 403 for missing organizations', async () => {
        await expect(
          members().findAllForActor({
            actorId: regularId,
            organizationId: randomUUID(),
          }),
        ).rejects.toMatchObject({ status: 403 });
      });
      it('enforces route metadata and forwards query parameters', async () => {
        const guard = new PermissionsGuard(
          new Reflector(),
          new PermissionsService(db as unknown as PrismaService),
        );
        const context = (id: string, actorId: string) =>
          ({
            getHandler: () =>
              Object.getOwnPropertyDescriptor(
                OrganizationMembersController.prototype,
                'findAll',
              )!.value,
            getClass: () => OrganizationMembersController,
            switchToHttp: () => ({
              getRequest: () => ({
                user: { id: actorId },
                params: { organizationId: id },
              }),
            }),
          }) as unknown as ExecutionContext;
        await expect(
          guard.canActivate(context(organizationId, regularId)),
        ).resolves.toBe(true);
        await expect(
          guard.canActivate(context(organizationId, superId)),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          guard.canActivate(context('invalid', regularId)),
        ).rejects.toMatchObject({ status: 400 });
        const query = Object.assign(new ListOrganizationMembersQueryDto(), {
          page: 2,
          limit: 1,
        });
        const response = await new OrganizationMembersController(
          members(),
        ).findAll(regularId, organizationId, query);
        expect(response).toMatchObject({ total: 2, page: 2, limit: 1 });
        expect(response.items).toHaveLength(1);
      });
    });

    describe('Organization updates', () => {
      let organizationId: string;
      let membershipId: string;
      let roleId: string;
      beforeEach(async () => {
        await seedOrganizationPermissions(db);
        const organization = await organizations().create(regularId, {
          name: 'Original team',
          slug: `update-${randomUUID()}`,
        });
        organizationId = organization.id;
        const role = await db.role.findFirstOrThrow({
          where: { organizationId, name: 'ADMIN' },
        });
        roleId = role.id;
        const membership = await db.organizationMember.create({
          data: {
            organizationId,
            userId: adminId,
            memberRoles: { create: { roleId } },
          },
        });
        membershipId = membership.id;
      });
      it.each(['owner', 'admin'])(
        'allows the %s to rename without changing other fields',
        async (actor) => {
          const before = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          const updated = await organizations().updateForActor(
            actor === 'owner' ? regularId : adminId,
            organizationId,
            { name: 'New team' },
          );
          expect(updated).toMatchObject({
            id: organizationId,
            name: 'New team',
            slug: before.slug,
            ownerId: regularId,
            isActive: true,
          });
          expect(updated).not.toHaveProperty('members');
          expect(updated).not.toHaveProperty('roles');
          expect(updated).not.toHaveProperty('deletedAt');
        },
      );
      it('ignores protected fields passed directly to the service', async () => {
        const original = await db.organization.findUniqueOrThrow({
          where: { id: organizationId },
        });
        const dto = {
          name: 'Allowed',
          ownerId: superId,
          slug: 'hijacked',
          isActive: false,
          deletedAt: new Date(),
        };
        await organizations().updateForActor(regularId, organizationId, dto);
        expect(
          await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          }),
        ).toMatchObject({
          name: 'Allowed',
          ownerId: regularId,
          slug: original.slug,
          isActive: true,
          deletedAt: null,
        });
      });
      it.each(['missing', 'deleted'])('rejects a %s actor', async (state) => {
        if (state === 'deleted')
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
        await expect(
          organizations().updateForActor(
            state === 'missing' ? randomUUID() : adminId,
            organizationId,
            { name: 'Denied' },
          ),
        ).rejects.toMatchObject({ status: 401 });
        expect(
          (
            await db.organization.findUniqueOrThrow({
              where: { id: organizationId },
            })
          ).name,
        ).toBe('Original team');
      });
      it('denies a platform SUPER_ADMIN without organization membership', async () => {
        await expect(
          organizations().updateForActor(superId, organizationId, {
            name: 'Denied',
          }),
        ).rejects.toMatchObject({ status: 403 });
      });
      it.each([
        'MEMBER',
        'inactive organization',
        'deleted organization',
        'suspended membership',
        'invited membership',
        'deleted membership',
        'assignment',
        'role',
        'link',
        'permission',
        'cross-organization role',
      ])('rejects update through %s and preserves the name', async (state) => {
        if (state === 'MEMBER') {
          const member = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'MEMBER' },
          });
          await db.memberRole.updateMany({
            where: { organizationMemberId: membershipId },
            data: { roleId: member.id },
          });
        }
        if (state === 'inactive organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { isActive: false },
          });
        if (state === 'deleted organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { deletedAt: new Date() },
          });
        if (state === 'suspended membership' || state === 'invited membership')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: {
              status:
                state === 'suspended membership' ? 'SUSPENDED' : 'INVITED',
            },
          });
        if (state === 'deleted membership')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'assignment')
          await db.memberRole.updateMany({
            where: { organizationMemberId: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'role')
          await db.role.update({
            where: { id: roleId },
            data: { deletedAt: new Date() },
          });
        const permission = await db.permission.findUniqueOrThrow({
          where: {
            action_resource: { resource: 'ORGANIZATION', action: 'update' },
          },
        });
        if (state === 'link')
          await db.rolePermission.updateMany({
            where: { roleId, permissionId: permission.id },
            data: { deletedAt: new Date() },
          });
        if (state === 'permission')
          await db.permission.update({
            where: { id: permission.id },
            data: { deletedAt: new Date() },
          });
        if (state === 'cross-organization role') {
          const other = await organizations().create(superId, {
            name: 'Other',
            slug: `other-${randomUUID()}`,
          });
          const role = await db.role.findFirstOrThrow({
            where: { organizationId: other.id, name: 'ADMIN' },
          });
          await db.memberRole.updateMany({
            where: { organizationMemberId: membershipId },
            data: { roleId: role.id },
          });
        }
        await expect(
          organizations().updateForActor(adminId, organizationId, {
            name: 'Denied',
          }),
        ).rejects.toMatchObject({ status: 403 });
        expect(
          (
            await db.organization.findUniqueOrThrow({
              where: { id: organizationId },
            })
          ).name,
        ).toBe('Original team');
      });
      it('denies updates by an owner whose membership is suspended', async () => {
        await db.organizationMember.updateMany({
          where: { userId: regularId, organizationId },
          data: { status: 'SUSPENDED' },
        });
        await expect(
          organizations().updateForActor(regularId, organizationId, {
            name: 'Denied',
          }),
        ).rejects.toMatchObject({ status: 403 });
      });
      it('returns 403 for nonexistent organizations too', async () => {
        await expect(
          organizations().updateForActor(adminId, randomUUID(), {
            name: 'Denied',
          }),
        ).rejects.toMatchObject({ status: 403 });
      });
      it('enforces update metadata in the guard and forwards the request through the controller', async () => {
        const guard = new PermissionsGuard(
          new Reflector(),
          new PermissionsService(db as unknown as PrismaService),
        );
        const context = (id: string) =>
          ({
            getHandler: () =>
              Object.getOwnPropertyDescriptor(
                OrganizationsController.prototype,
                'update',
              )!.value,
            getClass: () => OrganizationsController,
            switchToHttp: () => ({
              getRequest: () => ({
                user: { id: adminId },
                params: { organizationId: id },
              }),
            }),
          }) as unknown as ExecutionContext;
        await expect(guard.canActivate(context(organizationId))).resolves.toBe(
          true,
        );
        await expect(
          guard.canActivate(context('invalid')),
        ).rejects.toMatchObject({ status: 400 });
        const updated = await new OrganizationsController(
          organizations(),
        ).update(adminId, organizationId, { name: 'Controller update' });
        expect(updated.name).toBe('Controller update');
        await db.memberRole.updateMany({
          where: { organizationMemberId: membershipId },
          data: { deletedAt: new Date() },
        });
        await expect(
          guard.canActivate(context(organizationId)),
        ).rejects.toMatchObject({ status: 403 });
      });
    });

    describe('Organization reads', () => {
      let organizationId: string;
      let membershipId: string;
      let memberRoleId: string;
      beforeEach(async () => {
        await seedOrganizationPermissions(db);
        const org = await organizations().create(regularId, {
          name: 'Read fixture',
          slug: `read-${randomUUID()}`,
        });
        organizationId = org.id;
        const role = await db.role.findFirstOrThrow({
          where: { organizationId, name: 'MEMBER' },
        });
        memberRoleId = role.id;
        const member = await db.organizationMember.create({
          data: {
            userId: adminId,
            organizationId,
            memberRoles: { create: { roleId: role.id } },
          },
        });
        membershipId = member.id;
      });

      it.each(['owner', 'member'])(
        'lists only accessible details for an active %s',
        async (actor) => {
          const result = await organizations().findAllForActor({
            actorId: actor === 'owner' ? regularId : adminId,
          });
          expect(result).toMatchObject({ total: 1, page: 1, limit: 20 });
          expect(result.items).toHaveLength(1);
          expect(result.items[0].id).toBe(organizationId);
          expect(result.items[0]).not.toHaveProperty('members');
          expect(result.items[0]).not.toHaveProperty('roles');
          expect(result.items[0]).not.toHaveProperty('deletedAt');
        },
      );
      it('returns an empty list for a platform admin with no memberships', async () => {
        await expect(
          organizations().findAllForActor({ actorId: superId }),
        ).resolves.toEqual({ items: [], total: 0, page: 1, limit: 20 });
      });
      it('filters access before counting and pagination, with deterministic creation-time ties', async () => {
        const owned = await organizations().create(adminId, {
          name: 'Owned',
          slug: `owned-${randomUUID()}`,
        });
        await organizations().create(superId, {
          name: 'Hidden',
          slug: `hidden-${randomUUID()}`,
        });
        await db.organization.updateMany({
          data: { createdAt: new Date('2020-01-01') },
        });
        const expected = [owned.id, organizationId].sort();
        for (const page of [1, 2, 3]) {
          const result = await organizations().findAllForActor({
            actorId: adminId,
            page,
            limit: 1,
          });
          expect(result).toMatchObject({ total: 2, page, limit: 1 });
          expect(result.items.map((item) => item.id)).toEqual(
            page <= 2 ? [expected[page - 1]] : [],
          );
        }
      });
      it('does not duplicate organizations when multiple roles grant read', async () => {
        const role = await db.role.findFirstOrThrow({
          where: { organizationId, name: 'ADMIN' },
        });
        await db.memberRole.create({
          data: { organizationMemberId: membershipId, roleId: role.id },
        });
        const result = await organizations().findAllForActor({
          actorId: adminId,
        });
        expect(result.total).toBe(1);
        expect(result.items).toHaveLength(1);
      });
      it.each(['missing', 'deleted'])(
        'rejects listing for a %s actor',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          await expect(
            organizations().findAllForActor({
              actorId: state === 'missing' ? randomUUID() : adminId,
            }),
          ).rejects.toMatchObject({ status: 401 });
        },
      );
      it.each([
        { page: 0 },
        { page: 1.5 },
        { page: 1_000_001 },
        { limit: 0 },
        { limit: 101 },
        { limit: NaN },
      ])('rejects invalid direct-service pagination %j', async (query) => {
        await expect(
          organizations().findAllForActor({ actorId: adminId, ...query }),
        ).rejects.toMatchObject({ status: 422 });
      });
      it('forwards actor and pagination from the controller', async () => {
        const query = Object.assign(new ListOrganizationsQueryDto(), {
          page: 2,
          limit: 1,
        });
        const result = await new OrganizationsController(
          organizations(),
        ).findAll(adminId, query);
        expect(result).toEqual({ items: [], total: 1, page: 2, limit: 1 });
      });

      it.each(['owner', 'member'])(
        'allows an active %s and returns only organization details',
        async (actor) => {
          const result = await organizations().findOneForActor(
            actor === 'owner' ? regularId : adminId,
            organizationId,
          );
          expect(result).toMatchObject({
            id: organizationId,
            ownerId: regularId,
            isActive: true,
          });
          expect(Object.keys(result).sort()).toEqual(
            [
              'id',
              'name',
              'slug',
              'ownerId',
              'isActive',
              'createdAt',
              'updatedAt',
            ].sort(),
          );
        },
      );
      it('denies a platform SUPER_ADMIN without organization membership', async () => {
        await expect(
          organizations().findOneForActor(superId, organizationId),
        ).rejects.toMatchObject({ status: 403 });
      });
      it.each(['missing', 'deleted'])(
        'denies a %s service actor with 401',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          await expect(
            organizations().findOneForActor(
              state === 'missing' ? randomUUID() : adminId,
              organizationId,
            ),
          ).rejects.toMatchObject({ status: 401 });
        },
      );
      it.each([
        'inactive organization',
        'deleted organization',
        'suspended member',
        'invited member',
        'deleted member',
        'assignment',
        'role',
        'link',
        'permission',
        'legacy OWNER',
      ])('denies access after %s', async (state) => {
        if (state === 'inactive organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { isActive: false },
          });
        if (state === 'deleted organization')
          await db.organization.update({
            where: { id: organizationId },
            data: { deletedAt: new Date() },
          });
        if (state === 'suspended member' || state === 'invited member')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: {
              status: state === 'suspended member' ? 'SUSPENDED' : 'INVITED',
            },
          });
        if (state === 'deleted member')
          await db.organizationMember.update({
            where: { id: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'assignment')
          await db.memberRole.updateMany({
            where: { organizationMemberId: membershipId },
            data: { deletedAt: new Date() },
          });
        if (state === 'role')
          await db.role.update({
            where: { id: memberRoleId },
            data: { deletedAt: new Date() },
          });
        if (state === 'link')
          await db.rolePermission.updateMany({
            where: { roleId: memberRoleId },
            data: { deletedAt: new Date() },
          });
        if (state === 'permission')
          await db.permission.update({
            where: {
              action_resource: { resource: 'ORGANIZATION', action: 'read' },
            },
            data: { deletedAt: new Date() },
          });
        if (state === 'legacy OWNER')
          await db.role.update({
            where: { id: memberRoleId },
            data: { name: 'OWNER' },
          });
        await expect(
          organizations().findOneForActor(adminId, organizationId),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          organizations().findAllForActor({ actorId: adminId }),
        ).resolves.toMatchObject({ items: [], total: 0 });
      });
      it('does not let owner bypass suspended membership', async () => {
        await db.organizationMember.updateMany({
          where: { organizationId, userId: regularId },
          data: { status: 'SUSPENDED' },
        });
        await expect(
          organizations().findOneForActor(regularId, organizationId),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          organizations().findAllForActor({ actorId: regularId }),
        ).resolves.toMatchObject({ items: [], total: 0 });
      });
      it('denies missing organizations with the same 403 as inaccessible ones', async () => {
        await expect(
          organizations().findOneForActor(adminId, randomUUID()),
        ).rejects.toMatchObject({ status: 403 });
      });
      it('rejects a role assigned from another organization', async () => {
        const other = await organizations().create(superId, {
          name: 'Other',
          slug: `other-${randomUUID()}`,
        });
        const role = await db.role.findFirstOrThrow({
          where: { organizationId: other.id, name: 'ADMIN' },
        });
        await db.memberRole.updateMany({
          where: { organizationMemberId: membershipId },
          data: { roleId: role.id },
        });
        await expect(
          organizations().findOneForActor(adminId, organizationId),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          organizations().findAllForActor({ actorId: adminId }),
        ).resolves.toMatchObject({ items: [], total: 0 });
      });
      it('fails closed for empty permission requirements', async () => {
        expect(
          await new PermissionsService(
            db as unknown as PrismaService,
          ).hasOrganizationPermissions(regularId, organizationId, []),
        ).toBe(false);
      });
      it('enforces route permission metadata and UUID validation in the guard', async () => {
        const guard = new PermissionsGuard(
          new Reflector(),
          new PermissionsService(db as unknown as PrismaService),
        );
        const context = (actorId: string, id: string) =>
          ({
            getHandler: () =>
              Object.getOwnPropertyDescriptor(
                OrganizationsController.prototype,
                'findOne',
              )!.value,
            getClass: () => OrganizationsController,
            switchToHttp: () => ({
              getRequest: () => ({
                user: { id: actorId },
                params: { organizationId: id },
              }),
            }),
          }) as unknown as ExecutionContext;
        await expect(
          guard.canActivate(context(regularId, organizationId)),
        ).resolves.toBe(true);
        await expect(
          guard.canActivate(context(superId, organizationId)),
        ).rejects.toMatchObject({ status: 403 });
        await expect(
          guard.canActivate(context(regularId, 'invalid')),
        ).rejects.toMatchObject({ status: 400 });
        const result = await new OrganizationsController(
          organizations(),
        ).findOne(adminId, organizationId);
        expect(result.id).toBe(organizationId);
      });
    });

    describe('Organization creation', () => {
      const input = () => ({
        name: 'Fixture team',
        slug: `team-${randomUUID()}`,
      });

      beforeEach(async () => {
        await seedOrganizationPermissions(db);
      });

      it('creates owner membership and scoped roles with exactly the default permissions', async () => {
        const organization = await organizations().create(regularId, input());
        expect(organization).toMatchObject({
          ownerId: regularId,
          isActive: true,
          deletedAt: null,
        });
        const members = await db.organizationMember.findMany({
          where: { organizationId: organization.id },
          include: { memberRoles: true },
        });
        expect(members).toHaveLength(1);
        expect(members[0]).toMatchObject({
          userId: regularId,
          status: 'ACTIVE',
          deletedAt: null,
          memberRoles: [],
        });
        const roles = await db.role.findMany({
          where: { organizationId: organization.id },
          include: { rolePermissions: { include: { permission: true } } },
        });
        expect(roles.map((role) => role.name).sort()).toEqual([
          'ADMIN',
          'MEMBER',
        ]);
        for (const role of roles) {
          expect(role.isSystem).toBe(false);
          const grants = role.rolePermissions
            .map(
              ({ permission }) => `${permission.resource}:${permission.action}`,
            )
            .sort();
          const reads = [
            'ORGANIZATION:read',
            'ORGANIZATION_MEMBER:read',
            'ORGANIZATION_ROLE:read',
          ];
          expect(grants).toEqual(
            (role.name === 'ADMIN'
              ? [
                  ...reads,
                  'ORGANIZATION:update',
                  'ORGANIZATION_MEMBER:invite',
                  'ORGANIZATION_MEMBER:remove',
                ]
              : reads
            ).sort(),
          );
        }
      });

      it.each(['missing', 'deleted'])(
        'rejects a %s creator without creating records',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
          await expect(
            organizations().create(
              state === 'missing' ? randomUUID() : regularId,
              input(),
            ),
          ).rejects.toMatchObject({ status: 401 });
          expect(await db.organization.count()).toBe(0);
        },
      );

      it.each(['missing', 'revoked'])(
        'fails closed for a %s default permission',
        async (state) => {
          const where = {
            action_resource: { resource: 'ORGANIZATION_ROLE', action: 'read' },
          };
          if (state === 'missing') await db.permission.delete({ where });
          else
            await db.permission.update({
              where,
              data: { deletedAt: new Date() },
            });
          await expect(
            organizations().create(regularId, input()),
          ).rejects.toMatchObject({ status: 503 });
          expect(await db.organization.count()).toBe(0);
          expect(await db.organizationMember.count()).toBe(0);
        },
      );

      it('reserves slugs even after soft deletion', async () => {
        const dto = input();
        const organization = await organizations().create(regularId, dto);
        await db.organization.update({
          where: { id: organization.id },
          data: { deletedAt: new Date() },
        });
        await expect(
          organizations().create(adminId, dto),
        ).rejects.toMatchObject({ status: 409 });
        expect(await db.organization.count()).toBe(1);
      });

      it('rolls back organization and membership when role provisioning fails', async () => {
        await ddl!.query(
          `CREATE FUNCTION reject_org_role() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture role failure'; END $$`,
        );
        await ddl!.query(
          `CREATE TRIGGER reject_org_role BEFORE INSERT ON roles FOR EACH ROW EXECUTE FUNCTION reject_org_role()`,
        );
        try {
          await expect(
            organizations().create(regularId, input()),
          ).rejects.toThrow();
          expect(await db.organization.count()).toBe(0);
          expect(await db.organizationMember.count()).toBe(0);
        } finally {
          await ddl!.query('DROP TRIGGER reject_org_role ON roles');
          await ddl!.query('DROP FUNCTION reject_org_role()');
        }
      });

      it('coordinates creation with concurrent account deletion without a deleted owner', async () => {
        const results = await Promise.allSettled([
          organizations().create(regularId, input()),
          deleteAs(adminId, regularId),
        ]);
        expect(results.some((result) => result.status === 'fulfilled')).toBe(
          true,
        );
        expect(
          await db.organization.count({
            where: { deletedAt: null, owner: { deletedAt: { not: null } } },
          }),
        ).toBe(0);
        const owned = await db.organization.findFirst({
          where: { ownerId: regularId },
        });
        if (owned)
          expect(results[1]).toMatchObject({
            status: 'rejected',
            reason: { status: 409 },
          });
        else
          expect(results[0]).toMatchObject({
            status: 'rejected',
            reason: { status: 401 },
          });
      });
    });

    describe('Authorized paginated account listing', () => {
      it.each(['super admin', 'platform admin'])(
        'allows %s with USER:read and safe defaults',
        async (actor) => {
          const response = await service().findAllForActor({
            actorId: actor === 'super admin' ? superId : adminId,
          });
          expect(response).toMatchObject({ page: 1, limit: 20, total: 3 });
          expect(response.items).toHaveLength(3);
          for (const item of response.items) {
            expect(item).not.toHaveProperty('hashedPassword');
            expect(item).not.toHaveProperty('avatarKey');
            expect(item.avatarUrl).toMatch(
              /^http:\/\/storage.invalid\/avatars\//,
            );
          }
        },
      );

      it('rejects direct service calls by ordinary users', async () => {
        await expect(
          service().findAllForActor({ actorId: regularId }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it.each(['missing', 'deleted'])('rejects a %s actor', async (state) => {
        if (state === 'deleted')
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
        await expect(
          service().findAllForActor({
            actorId: state === 'missing' ? randomUUID() : adminId,
          }),
        ).rejects.toMatchObject({ status: 401 });
      });

      it.each([
        'assignment',
        'role',
        'link',
        'permission',
        'organization role',
        'delete only',
      ])('rejects listing through %s', async (invalid) => {
        const permission = await db.permission.findUniqueOrThrow({
          where: { action_resource: { action: 'read', resource: 'USER' } },
        });
        if (invalid === 'assignment')
          await db.userPlatformRole.updateMany({
            where: { userId: adminId },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'role')
          await db.role.update({
            where: { id: adminRoleId },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'link' || invalid === 'delete only')
          await db.rolePermission.updateMany({
            where: { roleId: adminRoleId, permissionId: permission.id },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'permission')
          await db.permission.update({
            where: { id: permission.id },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'organization role') {
          const org = await db.organization.create({
            data: { name: 'Fixture', slug: randomUUID(), ownerId: superId },
          });
          const role = await db.role.create({
            data: {
              name: 'ADMIN',
              organizationId: org.id,
              rolePermissions: { create: { permissionId: permission.id } },
            },
          });
          await db.userPlatformRole.updateMany({
            where: { userId: adminId },
            data: { roleId: role.id },
          });
        }
        await expect(
          service().findAllForActor({ actorId: adminId }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('does not bypass listing permissions for SUPER_ADMIN', async () => {
        await db.rolePermission.updateMany({
          where: { roleId: superRoleId },
          data: { deletedAt: new Date() },
        });
        await expect(
          service().findAllForActor({ actorId: superId }),
        ).rejects.toMatchObject({ status: 403 });
      });

      it('uses stable ID ordering when creation timestamps tie and pages do not overlap', async () => {
        await db.user.updateMany({
          data: { createdAt: new Date('2020-01-01') },
        });
        const ids: string[] = [];
        for (const page of [1, 2, 3]) {
          const result = await service().findAllForActor({
            actorId: adminId,
            page,
            limit: 1,
          });
          expect(result).toMatchObject({ total: 3, page, limit: 1 });
          expect(result.items).toHaveLength(1);
          ids.push(result.items[0].id);
        }
        expect(ids).toEqual([superId, adminId, regularId].sort());
      });

      it('excludes soft-deleted users from both count and items', async () => {
        await db.user.update({
          where: { id: regularId },
          data: { deletedAt: new Date() },
        });
        const result = await service().findAllForActor({ actorId: superId });
        expect(result.total).toBe(2);
        expect(result.items.map((user) => user.id)).not.toContain(regularId);
      });

      it('returns an empty page with the real total beyond the last page', async () => {
        await expect(
          service().findAllForActor({ actorId: adminId, page: 10, limit: 2 }),
        ).resolves.toMatchObject({ items: [], total: 3, page: 10, limit: 2 });
      });

      it.each([
        { page: 0 },
        { page: 1.5 },
        { page: 1_000_001 },
        { limit: 0 },
        { limit: 101 },
        { limit: Number.NaN },
      ])('bounds pagination for direct service calls: %j', async (query) => {
        await expect(
          service().findAllForActor({ actorId: adminId, ...query }),
        ).rejects.toMatchObject({ status: 422 });
      });

      it('forwards the query and authenticated actor through the controller', async () => {
        const query = Object.assign(new ListUsersQueryDto(), {
          page: 2,
          limit: 1,
        });
        const response = await new UsersController(service()).findAll(
          query,
          adminId,
        );
        expect(response).toMatchObject({ total: 3, page: 2, limit: 1 });
        expect(response.items).toHaveLength(1);
      });
    });

    describe('Actor-aware account reads', () => {
      const readAs = (actorId: string, targetId: string) =>
        service().findOneForActor({ actorId, targetId });

      it('allows regular self-access and returns no password hash or storage key', async () => {
        const response = await readAs(regularId, regularId);
        expect(response.id).toBe(regularId);
        expect(response).not.toHaveProperty('hashedPassword');
        expect(response).not.toHaveProperty('avatarKey');
        expect(response.avatarUrl).toMatch(
          /^http:\/\/storage.invalid\/avatars\//,
        );
      });

      it.each(['super admin', 'platform admin'])(
        'allows cross-account reads by %s with USER:read',
        async (actor) => {
          const response = await readAs(
            actor === 'super admin' ? superId : adminId,
            regularId,
          );
          expect(response.id).toBe(regularId);
          expect(response).not.toHaveProperty('hashedPassword');
          expect(response).not.toHaveProperty('avatarKey');
        },
      );

      it.each(['missing', 'deleted'])(
        'rejects a %s reader with 401',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          await expect(
            readAs(state === 'missing' ? randomUUID() : adminId, regularId),
          ).rejects.toMatchObject({ status: 401 });
        },
      );

      it.each(['existing', 'missing', 'deleted'])(
        'does not disclose a %s account to an unauthorized reader',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          await expect(
            readAs(regularId, state === 'missing' ? randomUUID() : adminId),
          ).rejects.toMatchObject({ status: 403 });
        },
      );

      it.each(['missing', 'deleted'])(
        'returns 404 for an authorized %s target',
        async (state) => {
          if (state === 'deleted')
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
          await expect(
            readAs(adminId, state === 'missing' ? randomUUID() : regularId),
          ).rejects.toMatchObject({ status: 404 });
        },
      );

      it.each([
        'assignment',
        'role',
        'link',
        'permission',
        'organization role',
        'delete only',
      ])('rejects cross-account reads through %s', async (invalid) => {
        const readPermission = await db.permission.findUniqueOrThrow({
          where: { action_resource: { action: 'read', resource: 'USER' } },
        });
        if (invalid === 'assignment')
          await db.userPlatformRole.updateMany({
            where: { userId: adminId },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'role')
          await db.role.update({
            where: { id: adminRoleId },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'link' || invalid === 'delete only')
          await db.rolePermission.updateMany({
            where: { roleId: adminRoleId, permissionId: readPermission.id },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'permission')
          await db.permission.update({
            where: { id: readPermission.id },
            data: { deletedAt: new Date() },
          });
        if (invalid === 'organization role') {
          const org = await db.organization.create({
            data: { name: 'Fixture', slug: randomUUID(), ownerId: superId },
          });
          const role = await db.role.create({
            data: {
              name: 'ADMIN',
              organizationId: org.id,
              rolePermissions: { create: { permissionId: readPermission.id } },
            },
          });
          await db.userPlatformRole.updateMany({
            where: { userId: adminId },
            data: { roleId: role.id },
          });
        }
        await expect(readAs(adminId, regularId)).rejects.toMatchObject({
          status: 403,
        });
        // Revoking platform authority must not block an active user's own profile.
        await expect(readAs(adminId, adminId)).resolves.toMatchObject({
          id: adminId,
        });
      });

      it('does not grant a SUPER_ADMIN permission bypass', async () => {
        await db.rolePermission.updateMany({
          where: { roleId: superRoleId },
          data: { deletedAt: new Date() },
        });
        await expect(readAs(superId, regularId)).rejects.toMatchObject({
          status: 403,
        });
        await expect(readAs(superId, superId)).resolves.toMatchObject({
          id: superId,
        });
      });

      it('forwards the authenticated actor and requested target through the controller', async () => {
        const response = await new UsersController(service()).findOne(
          regularId,
          adminId,
        );
        expect(response.id).toBe(regularId);
      });

      it('keeps the internal active-user lookup usable for JWT validation', async () => {
        const strategy = new JwtStrategy(
          new ConfigService({ JWT_ACCESS_TOKEN_SECRET: randomUUID() }),
          service(),
        );
        await expect(
          strategy.validate({ sub: regularId }),
        ).resolves.toMatchObject({ id: regularId });
      });
    });

    it.each(['missing', 'deleted'])(
      'rejects a %s actor with 401',
      async (state) => {
        if (state === 'deleted')
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
        await expectDenied(
          state === 'missing' ? randomUUID() : adminId,
          regularId,
          401,
        );
      },
    );
    it.each(['existing', 'missing', 'deleted'])(
      'rejects unauthorized access before disclosing a %s target',
      async (state) => {
        if (state === 'deleted')
          await db.user.update({
            where: { id: adminId },
            data: { deletedAt: new Date() },
          });
        await expect(
          deleteAs(regularId, state === 'missing' ? randomUUID() : adminId),
        ).rejects.toMatchObject({ status: 403 });
      },
    );
    it('returns 404 for an authorized missing target', async () => {
      await expect(deleteAs(adminId, randomUUID())).rejects.toMatchObject({
        status: 404,
      });
    });
    it.each(['self', 'platform admin', 'ordinary user'])(
      'protects SUPER_ADMIN from %s',
      async (actor) => {
        await expectDenied(
          actor === 'self'
            ? superId
            : actor === 'platform admin'
              ? adminId
              : regularId,
          superId,
          actor === 'ordinary user' ? 403 : 409,
        );
      },
    );
    it('protects SUPER_ADMIN even without its permission grants', async () => {
      await db.rolePermission.updateMany({
        where: { roleId: superRoleId },
        data: { deletedAt: new Date() },
      });
      await expectDenied(superId, superId, 409);
      await expectDenied(adminId, superId, 409);
    });
    it('does not grant SUPER_ADMIN protection merely from an organization role name', async () => {
      const org = await db.organization.create({
        data: { name: 'Fixture', slug: randomUUID(), ownerId: superId },
      });
      const role = await db.role.create({
        data: { name: 'SUPER_ADMIN', organizationId: org.id },
      });
      const membership = await db.organizationMember.create({
        data: { organizationId: org.id, userId: regularId },
      });
      await db.memberRole.create({
        data: { organizationMemberId: membership.id, roleId: role.id },
      });
      await deleteAs(regularId, regularId);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .deletedAt,
      ).not.toBeNull();
    });
    it.each(['self', 'super admin'])(
      'allows ordinary platform-admin deletion by %s',
      async (actor) => {
        await deleteAs(actor === 'self' ? adminId : superId, adminId);
        expect(
          (await db.user.findUniqueOrThrow({ where: { id: adminId } }))
            .deletedAt,
        ).not.toBeNull();
      },
    );
    it('allows a platform admin to delete another ordinary platform admin', async () => {
      const other = await createUser();
      await db.userPlatformRole.create({
        data: { userId: other.id, roleId: adminRoleId },
      });
      await deleteAs(adminId, other.id);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: other.id } }))
          .deletedAt,
      ).not.toBeNull();
    });
    it.each([true, false])(
      'blocks ownership of an undeleted organization with active=%s',
      async (isActive) => {
        await db.organization.create({
          data: {
            name: 'Fixture',
            slug: randomUUID(),
            ownerId: regularId,
            isActive,
          },
        });
        const token = await refreshToken(regularId);
        await expectDenied(superId, regularId, 409);
        await expectDenied(regularId, regularId, 409);
        expect(
          (await db.refreshToken.findUniqueOrThrow({ where: { id: token.id } }))
            .revokedAt,
        ).toBeNull();
      },
    );
    it('retains historical memberships, role assignments and avatar while revoking sessions', async () => {
      const user = await db.user.findUniqueOrThrow({
        where: { id: regularId },
      });
      const org = await db.organization.create({
        data: {
          name: 'Fixture',
          slug: randomUUID(),
          ownerId: regularId,
          deletedAt: new Date(),
        },
      });
      const membership = await db.organizationMember.create({
        data: { organizationId: org.id, userId: regularId },
      });
      const role = await db.role.create({
        data: { name: 'MEMBER', organizationId: org.id },
      });
      const assignment = await db.memberRole.create({
        data: { organizationMemberId: membership.id, roleId: role.id },
      });
      const platformAssignment = await db.userPlatformRole.create({
        data: { userId: regularId, roleId: adminRoleId },
      });
      const first = await refreshToken(regularId),
        second = await refreshToken(regularId);
      const otherToken = await refreshToken(adminId);
      await deleteAs(regularId, regularId);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .avatarKey,
      ).toBe(user.avatarKey);
      for (const id of [first.id, second.id])
        expect(
          (await db.refreshToken.findUniqueOrThrow({ where: { id } }))
            .revokedAt,
        ).not.toBeNull();
      expect(
        (
          await db.refreshToken.findUniqueOrThrow({
            where: { id: otherToken.id },
          })
        ).revokedAt,
      ).toBeNull();
      expect(
        (
          await db.organizationMember.findUniqueOrThrow({
            where: { id: membership.id },
          })
        ).deletedAt,
      ).toBeNull();
      expect(
        (
          await db.memberRole.findUniqueOrThrow({
            where: { id: assignment.id },
          })
        ).deletedAt,
      ).toBeNull();
      expect(
        (
          await db.userPlatformRole.findUniqueOrThrow({
            where: { id: platformAssignment.id },
          })
        ).deletedAt,
      ).toBeNull();
      const timestamp = (
        await db.user.findUniqueOrThrow({ where: { id: regularId } })
      ).deletedAt;
      await deleteAs(superId, regularId);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .deletedAt,
      ).toEqual(timestamp);
      const strategy = new JwtStrategy(
        new ConfigService({ JWT_ACCESS_TOKEN_SECRET: randomUUID() }),
        service(),
      );
      await expect(strategy.validate({ sub: regularId })).rejects.toMatchObject(
        { status: 401 },
      );
    });
    it('rolls back deletion when token revocation fails', async () => {
      const token = await refreshToken(regularId);
      const failure = new Error('Fixture revocation failure');
      const api = service(
        (manager) =>
          new Proxy(manager, {
            get(target, property) {
              if (property === 'refreshToken')
                return {
                  updateMany: async () => {
                    throw failure;
                  },
                };
              return Reflect.get(target, property);
            },
          }),
      );
      await expect(
        api.delete({ actorId: adminId, targetId: regularId }),
      ).rejects.toBe(failure);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .deletedAt,
      ).toBeNull();
      expect(
        (await db.refreshToken.findUniqueOrThrow({ where: { id: token.id } }))
          .revokedAt,
      ).toBeNull();
    });

    it.each([
      'assignment',
      'role',
      'link',
      'permission',
      'organization role',
      'read only',
    ])('does not grant deletion through %s', async (invalid) => {
      if (invalid === 'assignment')
        await db.userPlatformRole.updateMany({
          where: { userId: adminId },
          data: { deletedAt: new Date() },
        });
      if (invalid === 'role')
        await db.role.update({
          where: { id: adminRoleId },
          data: { deletedAt: new Date() },
        });
      if (invalid === 'link' || invalid === 'read only')
        await db.rolePermission.updateMany({
          where: { roleId: adminRoleId, permissionId },
          data: { deletedAt: new Date() },
        });
      if (invalid === 'permission')
        await db.permission.update({
          where: { id: permissionId },
          data: { deletedAt: new Date() },
        });
      if (invalid === 'organization role') {
        const org = await db.organization.create({
          data: { name: 'Fixture', slug: randomUUID(), ownerId: superId },
        });
        const role = await db.role.create({
          data: {
            name: 'ADMIN',
            organizationId: org.id,
            rolePermissions: { create: { permissionId } },
          },
        });
        await db.userPlatformRole.updateMany({
          where: { userId: adminId },
          data: { roleId: role.id },
        });
      }
      await expectDenied(adminId, regularId, 403);
    });

    it('retries forced concurrent deletion of the same account and remains idempotent', async () => {
      let reached = 0;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const api = service(
        (manager) =>
          new Proxy(manager, {
            get(target, property) {
              if (property !== 'user') return Reflect.get(target, property);
              return new Proxy(target.user, {
                get(delegate, method) {
                  if (method !== 'update') return Reflect.get(delegate, method);
                  return async (args: Prisma.UserUpdateArgs) => {
                    if (++reached === 2) release();
                    if (reached <= 2) await barrier;
                    return delegate.update(args);
                  };
                },
              });
            },
          }),
      );
      const results = await Promise.allSettled([
        api.delete({ actorId: adminId, targetId: regularId }),
        api.delete({ actorId: superId, targetId: regularId }),
      ]);
      expect(results.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
      expect(conflicts).toBeGreaterThan(0);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .deletedAt,
      ).not.toBeNull();
    });

    it('allows two ordinary admins to self-delete while SUPER_ADMIN remains protected', async () => {
      const other = await createUser();
      await db.userPlatformRole.create({
        data: { userId: other.id, roleId: adminRoleId },
      });
      await Promise.all([
        deleteAs(adminId, adminId),
        deleteAs(other.id, other.id),
      ]);
      await expectDenied(superId, superId, 409);
    });

    it('reruns bootstrap without changing account credentials or duplicating assignments', async () => {
      await seedConfig(superId);
      const before = await db.user.findUniqueOrThrow({
        where: { id: superId },
      });
      await seedAdmin(db);
      await seedAdmin(db);
      expect(
        await db.user.findUniqueOrThrow({ where: { id: superId } }),
      ).toEqual(before);
      expect(
        await db.userPlatformRole.count({
          where: { roleId: superRoleId, deletedAt: null },
        }),
      ).toBe(1);
    });
    it('refuses a second SUPER_ADMIN from a different bootstrap email', async () => {
      await seedConfig(regularId);
      await expect(seedAdmin(db)).rejects.toThrow(AdminSeedError);
      expect(
        await db.userPlatformRole.count({
          where: { roleId: superRoleId, deletedAt: null },
        }),
      ).toBe(1);
    });
    it('does not promote an ordinary account even when no other SUPER_ADMIN remains', async () => {
      await db.userPlatformRole.updateMany({
        where: { roleId: superRoleId },
        data: { deletedAt: new Date() },
      });
      await seedConfig(regularId);
      await expect(seedAdmin(db)).rejects.toThrow('refusing promotion');
    });
    it('creates the initial admin with a hashed password and normalizes identifiers', async () => {
      await db.userPlatformRole.deleteMany({ where: { roleId: superRoleId } });
      await seedConfig(superId);
      const key = randomUUID();
      const password = randomUUID();
      vi.stubEnv('SEED_ADMIN_EMAIL', `  ${key.toUpperCase()}@EXAMPLE.COM  `);
      vi.stubEnv('SEED_ADMIN_USERNAME', `  ${key.toUpperCase()}  `);
      vi.stubEnv('SEED_ADMIN_PASSWORD', password);
      await seedAdmin(db);
      const created = await db.user.findUniqueOrThrow({
        where: { email: `${key}@example.com` },
      });
      expect(created.username).toBe(key);
      expect(created.hashedPassword).not.toBe(password);
      expect(await compare(password, created.hashedPassword)).toBe(true);
      expect(
        await db.userPlatformRole.count({
          where: { userId: created.id, roleId: superRoleId, deletedAt: null },
        }),
      ).toBe(1);
    });
    it('allows only one concurrent bootstrap holder when two emails compete', async () => {
      await db.userPlatformRole.deleteMany({ where: { roleId: superRoleId } });
      await seedConfig(superId);
      const firstKey = randomUUID();
      vi.stubEnv('SEED_ADMIN_EMAIL', `${firstKey}@example.com`);
      vi.stubEnv('SEED_ADMIN_USERNAME', firstKey);
      const first = seedAdmin(db); // Configuration is captured before its hashing await.
      const secondKey = randomUUID();
      vi.stubEnv('SEED_ADMIN_EMAIL', `${secondKey}@example.com`);
      vi.stubEnv('SEED_ADMIN_USERNAME', secondKey);
      const results = await Promise.allSettled([first, seedAdmin(db)]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        results.find((result) => result.status === 'rejected'),
      ).toMatchObject({ reason: expect.any(AdminSeedError) });
      expect(
        await db.userPlatformRole.count({
          where: { roleId: superRoleId, deletedAt: null },
        }),
      ).toBe(1);
    });
    it.each([
      ['EMAIL', 'not-an-email'],
      ['USERNAME', '   '],
      ['PASSWORD', 'short'],
      ['PASSWORD', ' '.repeat(20)],
      ['PASSWORD', '\u00e9'.repeat(40)],
      ['FIRST_NAME', ''],
      ['LAST_NAME', ''],
      ['BIRTH_DATE', '2999-01-01'],
      ['BIRTH_DATE', 'not-a-date'],
    ])(
      'rejects invalid bootstrap %s without database writes',
      async (field, value) => {
        await seedConfig(superId);
        vi.stubEnv(`SEED_ADMIN_${field}`, value);
        const before = await db.user.count();
        await expect(seedAdmin(db)).rejects.toThrow(AdminSeedError);
        expect(await db.user.count()).toBe(before);
      },
    );
    it('forwards actor and target through the controller without deleting the caller', async () => {
      const controller = new UsersController(service());
      await controller.delete(regularId, adminId);
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: regularId } }))
          .deletedAt,
      ).not.toBeNull();
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: adminId } })).deletedAt,
      ).toBeNull();
    });
    it.each(['account', 'assignment'])(
      'does not restore a revoked bootstrap %s',
      async (state) => {
        if (state === 'account')
          await db.user.update({
            where: { id: superId },
            data: { deletedAt: new Date() },
          });
        else
          await db.userPlatformRole.updateMany({
            where: { userId: superId },
            data: { deletedAt: new Date() },
          });
        await seedConfig(superId);
        await expect(seedAdmin(db)).rejects.toThrow(AdminSeedError);
      },
    );
  },
);
