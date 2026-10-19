import { InvitationsService } from '../src/modules/organizations/invitations/services/invitations.service.js';
import { InvitationLinksService } from '../src/modules/organizations/invitations/services/invitation-links.service.js';
import type { InvitationEmailService } from '../src/modules/organizations/invitations/services/invitation-email.service.js';
import { OrganizationOwnershipService } from '../src/modules/organizations/ownership/organization-ownership.service.js';
import { OrganizationOwnershipController } from '../src/modules/organizations/ownership/organization-ownership.controller.js';
import { MemberRolesController } from '../src/modules/organizations/members/member-roles.controller.js';
import { MemberRolesService } from '../src/modules/organizations/members/member-roles.service.js';
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
        db.organizationInvitation.deleteMany(),
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
      describe('Removed member reinvitation', () => {
        const links = new InvitationLinksService(
          new ConfigService({
            INVITATION_TOKEN_SECRET: 'reinvitation-fixture-secret-'.repeat(4),
            FRONTEND_URL: 'http://frontend.invalid',
          }),
        );
        const enqueue = vi.fn(async () => true);
        const invitations = (hook?: Hook) => {
          const host = {
            serializableTransaction<T>(
              operation: (manager: Prisma.TransactionClient) => Promise<T>,
            ): Promise<T> {
              return PrismaService.prototype.serializableTransaction.call(
                { $transaction: db.$transaction.bind(db) },
                (manager: Prisma.TransactionClient) =>
                  operation(hook ? hook(manager) : manager),
              ) as Promise<T>;
            },
          } as PrismaService;
          return new InvitationsService(
            host,
            new PermissionsService(db as unknown as PrismaService),
            links,
            { enqueue } as unknown as InvitationEmailService,
          );
        };
        const remove = () =>
          members().removeForActor(regularId, organizationId, membershipId);
        const fresh = async () => {
          const user = await db.user.findUniqueOrThrow({
            where: { id: adminId },
          });
          await expect(
            invitations().create(regularId, organizationId, {
              email: user.email,
            }),
          ).resolves.toEqual({ emailQueued: true });
          return db.organizationInvitation.findFirstOrThrow({
            where: { organizationId, email: user.email, status: 'PENDING' },
          });
        };
        const rejoin = (id: string) =>
          invitations().accept(adminId, links.token(id));

        it('reinvites a removed admin and restores the same membership as MEMBER only', async () => {
          const adminRole = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          const custom = await db.role.create({
            data: { organizationId, name: 'LEGACY_CUSTOM' },
          });
          await db.memberRole.createMany({
            data: [
              { organizationMemberId: membershipId, roleId: adminRole.id },
              { organizationMemberId: membershipId, roleId: custom.id },
            ],
          });
          await remove();
          await expect(
            organizations().currentPermissions(adminId, organizationId),
          ).rejects.toMatchObject({ status: 403 });
          const invitation = await fresh();
          expect(
            (
              await db.organizationMember.findUniqueOrThrow({
                where: { id: membershipId },
              })
            ).deletedAt,
          ).toBeInstanceOf(Date);
          await expect(rejoin(invitation.id)).resolves.toEqual({
            organizationId,
            membershipId,
          });
          expect(
            await db.organizationMember.count({
              where: { organizationId, userId: adminId },
            }),
          ).toBe(1);
          expect(
            await db.organizationMember.findUniqueOrThrow({
              where: { id: membershipId },
            }),
          ).toMatchObject({ status: 'ACTIVE', deletedAt: null });
          expect(
            await db.memberRole.findMany({
              where: { organizationMemberId: membershipId, deletedAt: null },
            }),
          ).toEqual([expect.objectContaining({ roleId })]);
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: membershipId },
            }),
          ).toBe(3);
          expect(
            await organizations().currentPermissions(adminId, organizationId),
          ).toHaveLength(3);
          expect(
            await db.organizationInvitation.findUniqueOrThrow({
              where: { id: invitation.id },
            }),
          ).toMatchObject({ status: 'ACCEPTED', acceptedById: adminId });
        });

        it('restores an existing revoked MEMBER assignment without duplicates', async () => {
          const original = await db.memberRole.findFirstOrThrow({
            where: { organizationMemberId: membershipId, roleId },
          });
          await db.memberRole.update({
            where: { id: original.id },
            data: { deletedAt: new Date() },
          });
          await remove();
          const invitation = await fresh();
          await rejoin(invitation.id);
          expect(
            await db.memberRole.findUniqueOrThrow({
              where: { id: original.id },
            }),
          ).toMatchObject({ deletedAt: null });
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: membershipId },
            }),
          ).toBe(1);
        });

        it.each([
          'active',
          'suspended',
          'removed suspended',
          'deleted account',
        ])('does not invite an %s account/membership', async (kind) => {
          if (kind === 'suspended')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { status: 'SUSPENDED' },
            });
          if (kind === 'removed suspended')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { status: 'SUSPENDED', deletedAt: new Date() },
            });
          if (kind === 'deleted account')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          const user = await db.user.findUniqueOrThrow({
            where: { id: adminId },
          });
          await expect(
            invitations().create(regularId, organizationId, {
              email: user.email,
            }),
          ).rejects.toMatchObject({ status: 409 });
          expect(
            await db.organizationInvitation.count({
              where: { organizationId },
            }),
          ).toBe(0);
        });

        it('rejects old links after removal and supersedes stale pending invitations on a fresh request', async () => {
          const user = await db.user.findUniqueOrThrow({
            where: { id: adminId },
          });
          const id = randomUUID();
          const old = await db.organizationInvitation.create({
            data: {
              id,
              organizationId,
              email: user.email,
              tokenHash: links.hash(links.token(id)),
              invitedById: regularId,
              expiresAt: new Date(Date.now() + 60_000),
              createdAt: new Date(Date.now() - 86_400_000),
            },
          });
          await remove();
          await expect(rejoin(old.id)).rejects.toMatchObject({ status: 409 });
          await expect(
            invitations().resend(regularId, organizationId, old.id),
          ).rejects.toMatchObject({ status: 409 });
          await expect(
            invitations().copyLink(regularId, organizationId, old.id),
          ).rejects.toMatchObject({ status: 409 });
          const invitation = await fresh();
          expect(
            (
              await db.organizationInvitation.findUniqueOrThrow({
                where: { id: old.id },
              })
            ).status,
          ).toBe('REVOKED');
          await rejoin(invitation.id);
        });

        it('requires the matching email and respects revocation/expiry', async () => {
          await remove();
          const invitation = await fresh();
          await expect(
            invitations().accept(regularId, links.token(invitation.id)),
          ).rejects.toMatchObject({ status: 403 });
          await db.organizationInvitation.update({
            where: { id: invitation.id },
            data: { expiresAt: new Date(Date.now() - 1000) },
          });
          await expect(rejoin(invitation.id)).rejects.toMatchObject({
            status: 409,
          });
          await db.organizationInvitation.update({
            where: { id: invitation.id },
            data: {
              expiresAt: new Date(Date.now() + 60_000),
              status: 'REVOKED',
            },
          });
          await expect(rejoin(invitation.id)).rejects.toMatchObject({
            status: 409,
          });
        });

        it('still allows resend and copy of a fresh invitation after removal', async () => {
          await remove();
          const invitation = await fresh();
          await expect(
            invitations().copyLink(regularId, organizationId, invitation.id),
          ).resolves.toMatchObject({ inviteLink: links.link(invitation.id) });
          await db.organizationInvitation.update({
            where: { id: invitation.id },
            data: { lastRequestedAt: new Date(Date.now() - 61_000) },
          });
          await expect(
            invitations().resend(regularId, organizationId, invitation.id),
          ).resolves.toEqual({ emailQueued: true });
          await rejoin(invitation.id);
        });

        it.each([
          'suspended',
          'already restored',
          'deleted user',
          'inactive organization',
          'deleted MEMBER role',
        ])('rechecks %s at acceptance', async (kind) => {
          await remove();
          const invitation = await fresh();
          if (kind === 'suspended')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { status: 'SUSPENDED' },
            });
          if (kind === 'already restored')
            await db.organizationMember.update({
              where: { id: membershipId },
              data: { deletedAt: null },
            });
          if (kind === 'deleted user')
            await db.user.update({
              where: { id: adminId },
              data: { deletedAt: new Date() },
            });
          if (kind === 'inactive organization')
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
          if (kind === 'deleted MEMBER role')
            await db.role.update({
              where: { id: roleId },
              data: { deletedAt: new Date() },
            });
          await expect(rejoin(invitation.id)).rejects.toMatchObject({
            status:
              kind === 'deleted user'
                ? 401
                : kind === 'deleted MEMBER role'
                  ? 503
                  : 409,
          });
          expect(
            (
              await db.organizationInvitation.findUniqueOrThrow({
                where: { id: invitation.id },
              })
            ).status,
          ).toBe('PENDING');
        });

        it('rolls back invitation consumption and role changes if membership restoration fails', async () => {
          await remove();
          const invitation = await fresh();
          const service = invitations(
            (manager) =>
              new Proxy(manager, {
                get(target, property) {
                  if (property !== 'organizationMember')
                    return Reflect.get(target, property);
                  return new Proxy(target.organizationMember, {
                    get(delegate, method) {
                      if (method !== 'update')
                        return Reflect.get(delegate, method);
                      return () => {
                        throw new Error('Fixture restoration failure');
                      };
                    },
                  });
                },
              }),
          );
          await expect(
            service.accept(adminId, links.token(invitation.id)),
          ).rejects.toThrow('Fixture restoration failure');
          expect(
            (
              await db.organizationInvitation.findUniqueOrThrow({
                where: { id: invitation.id },
              })
            ).status,
          ).toBe('PENDING');
          expect(
            (
              await db.organizationMember.findUniqueOrThrow({
                where: { id: membershipId },
              })
            ).deletedAt,
          ).toBeInstanceOf(Date);
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: membershipId, deletedAt: null },
            }),
          ).toBe(1);
        });

        it('consumes a reinvitation only once under concurrent acceptance', async () => {
          await remove();
          const invitation = await fresh();
          const results = await Promise.allSettled([
            rejoin(invitation.id),
            rejoin(invitation.id),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          expect(
            results.find((result) => result.status === 'rejected'),
          ).toMatchObject({ reason: { status: 409 } });
          expect(
            await db.organizationMember.count({
              where: { organizationId, userId: adminId },
            }),
          ).toBe(1);
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: membershipId, deletedAt: null },
            }),
          ).toBe(1);
        });

        it('coordinates acceptance and revocation so a revoked invitation cannot restore access', async () => {
          await remove();
          const invitation = await fresh();
          let reached = 0;
          let release!: () => void;
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          const wait = async () => {
            if (++reached === 2) release();
            if (reached <= 2) await barrier;
          };
          const hook: Hook = (manager) =>
            new Proxy(manager, {
              get(target, property) {
                if (property !== 'organizationInvitation')
                  return Reflect.get(target, property);
                return new Proxy(target.organizationInvitation, {
                  get(delegate, method) {
                    if (method === 'findUnique')
                      return async (
                        args: Prisma.OrganizationInvitationFindUniqueArgs,
                      ) => {
                        const value = await delegate.findUnique(args);
                        await wait();
                        return value;
                      };
                    if (method === 'findFirst')
                      return async (
                        args: Prisma.OrganizationInvitationFindFirstArgs,
                      ) => {
                        const value = await delegate.findFirst(args);
                        await wait();
                        return value;
                      };
                    return Reflect.get(delegate, method);
                  },
                });
              },
            });
          const results = await Promise.allSettled([
            invitations(hook).accept(adminId, links.token(invitation.id)),
            invitations(hook).revoke(regularId, organizationId, invitation.id),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const final = await db.organizationInvitation.findUniqueOrThrow({
            where: { id: invitation.id },
          });
          const member = await db.organizationMember.findUniqueOrThrow({
            where: { id: membershipId },
          });
          expect(member.deletedAt === null).toBe(final.status === 'ACCEPTED');
        });
      });

      describe('Organization soft deletion', () => {
        const grantPlatformDelete = async () => {
          const permission = await db.permission.create({
            data: { resource: 'ORGANIZATION', action: 'delete' },
          });
          await db.rolePermission.create({
            data: { roleId: superRoleId, permissionId: permission.id },
          });
          return permission;
        };
        const host = (hook?: Hook) =>
          ({
            serializableTransaction<T>(
              operation: (manager: Prisma.TransactionClient) => Promise<T>,
            ): Promise<T> {
              return PrismaService.prototype.serializableTransaction.call(
                { $transaction: db.$transaction.bind(db) },
                (manager: Prisma.TransactionClient) =>
                  operation(hook ? hook(manager) : manager),
              ) as Promise<T>;
            },
          }) as PrismaService;
        const deletion = (hook?: Hook) =>
          new OrganizationsService(
            host(hook),
            new PermissionsService(db as unknown as PrismaService),
          );
        const remove = (actorId = regularId, id = organizationId) =>
          deletion().deleteForActor(actorId, id);
        const invite = (
          status: 'PENDING' | 'ACCEPTED' = 'PENDING',
          orgId = organizationId,
        ) =>
          db.organizationInvitation.create({
            data: {
              organizationId: orgId,
              email: `${randomUUID()}@example.com`,
              tokenHash: randomUUID(),
              invitedById: regularId,
              expiresAt: new Date(Date.now() + 60_000),
              status,
            },
          });

        it('allows owners without a deletion grant and retains membership/role history', async () => {
          const before = {
            members: await db.organizationMember.count({
              where: { organizationId },
            }),
            roles: await db.role.count({ where: { organizationId } }),
            assignments: await db.memberRole.count(),
          };
          await expect(remove()).resolves.toBeUndefined();
          expect(
            await db.organization.findUniqueOrThrow({
              where: { id: organizationId },
            }),
          ).toMatchObject({ deletedAt: expect.any(Date), isActive: false });
          expect(
            await db.organizationMember.count({ where: { organizationId } }),
          ).toBe(before.members);
          expect(await db.role.count({ where: { organizationId } })).toBe(
            before.roles,
          );
          expect(await db.memberRole.count()).toBe(before.assignments);
          await expect(
            organizations().currentPermissions(regularId, organizationId),
          ).rejects.toMatchObject({ status: 403 });
          await expect(
            organizations().currentPermissions(adminId, organizationId),
          ).rejects.toMatchObject({ status: 403 });
        });

        it('requires exact active platform deletion permission for the platform bypass', async () => {
          await expect(remove(superId)).rejects.toMatchObject({ status: 403 });
          const permission = await grantPlatformDelete();
          await expect(remove(superId)).resolves.toBeUndefined();
          await db.rolePermission.updateMany({
            where: { roleId: superRoleId, permissionId: permission.id },
            data: { deletedAt: new Date() },
          });
          await expect(remove(superId)).rejects.toMatchObject({ status: 403 });
        });

        it('does not accept organization ADMIN or organization-role deletion grants', async () => {
          const admin = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          await db.memberRole.create({
            data: { organizationMemberId: membershipId, roleId: admin.id },
          });
          const permission = await db.permission.create({
            data: { resource: 'ORGANIZATION', action: 'delete' },
          });
          await db.rolePermission.create({
            data: { roleId: admin.id, permissionId: permission.id },
          });
          await expect(remove(adminId)).rejects.toMatchObject({ status: 403 });
        });

        it.each([
          'revoked permission',
          'revoked platform role',
          'deleted platform role',
        ])('rejects a %s', async (kind) => {
          const permission = await grantPlatformDelete();
          if (kind === 'revoked permission')
            await db.permission.update({
              where: { id: permission.id },
              data: { deletedAt: new Date() },
            });
          if (kind === 'revoked platform role')
            await db.userPlatformRole.updateMany({
              where: { userId: superId },
              data: { deletedAt: new Date() },
            });
          if (kind === 'deleted platform role')
            await db.role.update({
              where: { id: superRoleId },
              data: { deletedAt: new Date() },
            });
          await expect(remove(superId)).rejects.toMatchObject({ status: 403 });
        });

        it('requires active owner membership but permits deletion of an inactive organization', async () => {
          await db.organizationMember.updateMany({
            where: { organizationId, userId: regularId },
            data: { status: 'SUSPENDED' },
          });
          await expect(remove()).rejects.toMatchObject({ status: 403 });
          await db.organizationMember.updateMany({
            where: { organizationId, userId: regularId },
            data: { status: 'ACTIVE' },
          });
          await db.organization.update({
            where: { id: organizationId },
            data: { isActive: false },
          });
          await expect(remove()).resolves.toBeUndefined();
        });

        it('revokes pending invitations atomically without changing accepted or other organization invitations', async () => {
          const pending = await invite();
          const accepted = await invite('ACCEPTED');
          const other = await organizations().create(regularId, {
            name: 'Other',
            slug: `delete-other-${randomUUID()}`,
          });
          const unrelated = await invite('PENDING', other.id);
          await remove();
          expect(
            await db.organizationInvitation.findUniqueOrThrow({
              where: { id: pending.id },
            }),
          ).toMatchObject({ status: 'REVOKED', revokedAt: expect.any(Date) });
          expect(
            await db.organizationInvitation.findUniqueOrThrow({
              where: { id: accepted.id },
            }),
          ).toMatchObject({ status: 'ACCEPTED', revokedAt: null });
          expect(
            await db.organizationInvitation.findUniqueOrThrow({
              where: { id: unrelated.id },
            }),
          ).toMatchObject({ status: 'PENDING', revokedAt: null });
        });

        it('rolls back deletion if invitation revocation fails', async () => {
          await invite();
          const api = deletion(
            (manager) =>
              new Proxy(manager, {
                get(target, property) {
                  if (property !== 'organizationInvitation')
                    return Reflect.get(target, property);
                  return new Proxy(target.organizationInvitation, {
                    get(delegate, method) {
                      if (method !== 'updateMany')
                        return Reflect.get(delegate, method);
                      return () => {
                        throw new Error('Fixture revocation failure');
                      };
                    },
                  });
                },
              }),
          );
          await expect(
            api.deleteForActor(regularId, organizationId),
          ).rejects.toThrow('Fixture revocation failure');
          expect(
            (
              await db.organization.findUniqueOrThrow({
                where: { id: organizationId },
              })
            ).deletedAt,
          ).toBeNull();
        });

        it('authenticates before lookup and masks missing organizations from non-platform callers', async () => {
          await expect(remove(randomUUID())).rejects.toMatchObject({
            status: 401,
          });
          await expect(remove(regularId, randomUUID())).rejects.toMatchObject({
            status: 403,
          });
          await grantPlatformDelete();
          await expect(remove(superId, randomUUID())).rejects.toMatchObject({
            status: 404,
          });
          await db.user.update({
            where: { id: regularId },
            data: { deletedAt: new Date() },
          });
          await expect(remove()).rejects.toMatchObject({ status: 401 });
        });

        it('allows owner account deletion after all owned organizations are deleted', async () => {
          await remove();
          await expect(deleteAs(regularId, regularId)).resolves.toBeUndefined();
        });

        it('makes concurrent and repeated authorized deletion idempotent', async () => {
          await Promise.all([remove(), remove()]);
          const original = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          await remove();
          expect(
            (
              await db.organization.findUniqueOrThrow({
                where: { id: organizationId },
              })
            ).deletedAt,
          ).toEqual(original.deletedAt);
        });

        it('exposes owner-or-platform deletion without requiring either permission decorator alone', async () => {
          const response = await new OrganizationsController(deletion()).delete(
            regularId,
            organizationId,
          );
          expect(response).toBeUndefined();
          expect(
            new Reflector().get(
              'requiredOrganizationPermissions',
              Reflect.get(OrganizationsController.prototype, 'delete'),
            ),
          ).toBeUndefined();
        });

        it('serializes owner deletion against ownership transfer and rechecks the winning ownership', async () => {
          let reached = 0;
          let release!: () => void;
          const barrier = new Promise<void>((resolve) => {
            release = resolve;
          });
          const hook: Hook = (manager) =>
            new Proxy(manager, {
              get(target, property) {
                if (property !== 'organization')
                  return Reflect.get(target, property);
                return new Proxy(target.organization, {
                  get(delegate, method) {
                    if (method !== 'update')
                      return Reflect.get(delegate, method);
                    return async (args: Prisma.OrganizationUpdateArgs) => {
                      if (++reached === 2) release();
                      if (reached <= 2) await barrier;
                      return delegate.update(args);
                    };
                  },
                });
              },
            });
          const results = await Promise.allSettled([
            deletion(hook).deleteForActor(regularId, organizationId),
            new OrganizationOwnershipService(host(hook)).transferForActor(
              regularId,
              organizationId,
              membershipId,
            ),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          expect(
            results.find((result) => result.status === 'rejected'),
          ).toMatchObject({ reason: { status: 403 } });
          const organization = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          if (organization.deletedAt)
            expect(organization.ownerId).toBe(regularId);
          else expect(organization.ownerId).toBe(adminId);
        });
      });

      describe('Ownership transfer', () => {
        const host = (hook?: Hook) =>
          ({
            serializableTransaction<T>(
              operation: (manager: Prisma.TransactionClient) => Promise<T>,
            ): Promise<T> {
              return PrismaService.prototype.serializableTransaction.call(
                { $transaction: db.$transaction.bind(db) },
                (manager: Prisma.TransactionClient) =>
                  operation(hook ? hook(manager) : manager),
              ) as Promise<T>;
            },
          }) as PrismaService;
        const ownership = (hook?: Hook) =>
          new OrganizationOwnershipService(host(hook));
        const transfer = (actorId = regularId, targetId = membershipId) =>
          ownership().transferForActor(actorId, organizationId, targetId);
        const ownerMembership = () =>
          db.organizationMember.findUniqueOrThrow({
            where: {
              organizationId_userId: { organizationId, userId: regularId },
            },
          });

        it('transfers ownerId, preserves memberships and gives the former owner MEMBER only', async () => {
          await expect(transfer()).resolves.toEqual({
            id: organizationId,
            ownerId: adminId,
            previousOwnerId: regularId,
          });
          const previous = await ownerMembership();
          expect(previous).toMatchObject({ status: 'ACTIVE', deletedAt: null });
          expect(
            await db.memberRole.findMany({
              where: { organizationMemberId: previous.id, deletedAt: null },
            }),
          ).toEqual([expect.objectContaining({ roleId })]);
          expect(
            await db.organization.count({
              where: { id: organizationId, ownerId: adminId },
            }),
          ).toBe(1);
          expect(
            await organizations().currentPermissions(adminId, organizationId),
          ).toHaveLength(11);
          expect(
            await organizations().currentPermissions(regularId, organizationId),
          ).toHaveLength(3);
          await expect(transfer()).rejects.toMatchObject({ status: 403 });
        });

        it('preserves existing roles and restores a revoked MEMBER assignment without creating duplicates', async () => {
          const previous = await ownerMembership();
          const admin = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          await db.memberRole.createMany({
            data: [
              { organizationMemberId: previous.id, roleId: admin.id },
              {
                organizationMemberId: previous.id,
                roleId,
                deletedAt: new Date(),
              },
            ],
          });
          await transfer();
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: previous.id, deletedAt: null },
            }),
          ).toBe(2);
          expect(
            await db.memberRole.count({
              where: { organizationMemberId: previous.id, roleId },
            }),
          ).toBe(1);
        });

        it('does not rewrite an already active MEMBER assignment', async () => {
          const previous = await ownerMembership();
          const assignment = await db.memberRole.create({
            data: { organizationMemberId: previous.id, roleId },
          });
          await transfer();
          expect(
            (
              await db.memberRole.findUniqueOrThrow({
                where: { id: assignment.id },
              })
            ).updatedAt,
          ).toEqual(assignment.updatedAt);
        });

        it('authorizes actual ownership only, without organization admin or platform admin bypass', async () => {
          const admin = await db.role.findFirstOrThrow({
            where: { organizationId, name: 'ADMIN' },
          });
          await db.memberRole.create({
            data: { organizationMemberId: membershipId, roleId: admin.id },
          });
          for (const actor of [adminId, superId])
            await expect(transfer(actor)).rejects.toMatchObject({
              status: 403,
            });
        });

        it('rejects transfer to self and nonlocal membership IDs', async () => {
          await expect(
            transfer(regularId, (await ownerMembership()).id),
          ).rejects.toMatchObject({ status: 409 });
          const other = await organizations().create(regularId, {
            name: 'Other',
            slug: `transfer-${randomUUID()}`,
          });
          const foreign = await db.organizationMember.findUniqueOrThrow({
            where: {
              organizationId_userId: {
                organizationId: other.id,
                userId: regularId,
              },
            },
          });
          await expect(transfer(regularId, foreign.id)).rejects.toMatchObject({
            status: 404,
          });
          await expect(transfer(regularId, randomUUID())).rejects.toMatchObject(
            { status: 404 },
          );
        });

        it.each(['removed', 'suspended', 'invited', 'deleted user'])(
          'rejects a %s recipient',
          async (kind) => {
            if (kind === 'removed')
              await db.organizationMember.update({
                where: { id: membershipId },
                data: { deletedAt: new Date() },
              });
            if (kind === 'suspended')
              await db.organizationMember.update({
                where: { id: membershipId },
                data: { status: 'SUSPENDED' },
              });
            if (kind === 'invited')
              await db.organizationMember.update({
                where: { id: membershipId },
                data: { status: 'INVITED' },
              });
            if (kind === 'deleted user')
              await db.user.update({
                where: { id: adminId },
                data: { deletedAt: new Date() },
              });
            await expect(transfer()).rejects.toMatchObject({ status: 404 });
            expect(
              (
                await db.organization.findUniqueOrThrow({
                  where: { id: organizationId },
                })
              ).ownerId,
            ).toBe(regularId);
          },
        );

        it.each([
          'removed owner membership',
          'suspended owner membership',
          'inactive organization',
          'deleted organization',
        ])('rejects %s', async (kind) => {
          if (kind === 'removed owner membership')
            await db.organizationMember.update({
              where: { id: (await ownerMembership()).id },
              data: { deletedAt: new Date() },
            });
          if (kind === 'suspended owner membership')
            await db.organizationMember.update({
              where: { id: (await ownerMembership()).id },
              data: { status: 'SUSPENDED' },
            });
          if (kind === 'inactive organization')
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
          if (kind === 'deleted organization')
            await db.organization.update({
              where: { id: organizationId },
              data: { deletedAt: new Date() },
            });
          await expect(transfer()).rejects.toMatchObject({ status: 403 });
        });

        it('rejects missing/deleted callers with 401 and inaccessible organizations with 403', async () => {
          await expect(transfer(randomUUID())).rejects.toMatchObject({
            status: 401,
          });
          await expect(
            ownership().transferForActor(regularId, randomUUID(), membershipId),
          ).rejects.toMatchObject({ status: 403 });
          await db.user.update({
            where: { id: regularId },
            data: { deletedAt: new Date() },
          });
          await expect(transfer()).rejects.toMatchObject({ status: 401 });
        });

        it('rolls back transfer if the MEMBER role is unavailable', async () => {
          await db.role.update({
            where: { id: roleId },
            data: { deletedAt: new Date() },
          });
          await expect(transfer()).rejects.toMatchObject({ status: 503 });
          expect(
            (
              await db.organization.findUniqueOrThrow({
                where: { id: organizationId },
              })
            ).ownerId,
          ).toBe(regularId);
        });

        it('lets the previous owner delete their account while protecting the new owner', async () => {
          await transfer();
          await expect(deleteAs(superId, adminId)).rejects.toMatchObject({
            status: 409,
          });
          await expect(deleteAs(superId, regularId)).resolves.toBeUndefined();
        });

        it('forwards authenticated IDs without requiring a delegable transfer permission', async () => {
          const response = await new OrganizationOwnershipController(
            ownership(),
          ).transfer(regularId, organizationId, { memberId: membershipId });
          expect(response).toMatchObject({
            ownerId: adminId,
            previousOwnerId: regularId,
          });
          expect(
            new Reflector().get(
              'requiredOrganizationPermissions',
              Reflect.get(
                OrganizationOwnershipController.prototype,
                'transfer',
              ),
            ),
          ).toBeUndefined();
        });

        // Force both transactions to read their initial snapshots before mutations.
        const rendezvous = () => {
          let reached = 0;
          let release!: () => void;
          const ready = new Promise<void>((resolve) => {
            release = resolve;
          });
          return async () => {
            if (++reached === 2) release();
            if (reached <= 2) await ready;
          };
        };
        const pauseTransfer =
          (wait: () => Promise<void>): Hook =>
          (manager) =>
            new Proxy(manager, {
              get(target, property) {
                if (property !== 'organizationMember')
                  return Reflect.get(target, property);
                return new Proxy(target.organizationMember, {
                  get(delegate, method) {
                    if (method !== 'findFirst')
                      return Reflect.get(delegate, method);
                    return async (
                      args: Prisma.OrganizationMemberFindFirstArgs,
                    ) => {
                      const result = await delegate.findFirst(args);
                      if (args.where?.id) await wait();
                      return result;
                    };
                  },
                });
              },
            });

        it('serializes competing transfers so only one request by the old owner succeeds', async () => {
          const second = await createUser();
          const secondMembership = await db.organizationMember.create({
            data: { organizationId, userId: second.id },
          });
          const wait = rendezvous();
          const api = ownership(pauseTransfer(wait));
          const results = await Promise.allSettled([
            api.transferForActor(regularId, organizationId, membershipId),
            api.transferForActor(
              regularId,
              organizationId,
              secondMembership.id,
            ),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          expect(
            results.find((result) => result.status === 'rejected'),
          ).toMatchObject({ reason: { status: 403 } });
          const org = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          expect([adminId, second.id]).toContain(org.ownerId);
          expect(
            await db.organizationMember.count({
              where: {
                organizationId,
                userId: org.ownerId,
                status: 'ACTIVE',
                deletedAt: null,
                user: { deletedAt: null },
              },
            }),
          ).toBe(1);
        });

        it('coordinates transfer with deletion of the prospective owner account', async () => {
          const wait = rendezvous();
          const deleting = service(
            (manager) =>
              new Proxy(manager, {
                get(target, property) {
                  if (property !== 'user') return Reflect.get(target, property);
                  return new Proxy(target.user, {
                    get(delegate, method) {
                      if (method !== 'update')
                        return Reflect.get(delegate, method);
                      return async (args: Prisma.UserUpdateArgs) => {
                        await wait();
                        return delegate.update(args);
                      };
                    },
                  });
                },
              }),
          );
          const results = await Promise.allSettled([
            ownership(pauseTransfer(wait)).transferForActor(
              regularId,
              organizationId,
              membershipId,
            ),
            deleting.delete({ actorId: superId, targetId: adminId }),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const org = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          expect(
            (await db.user.findUniqueOrThrow({ where: { id: org.ownerId } }))
              .deletedAt,
          ).toBeNull();
        });

        it('coordinates transfer with removal of the prospective owner membership', async () => {
          const wait = rendezvous();
          const removing = new OrganizationMembersService(
            host(
              (manager) =>
                new Proxy(manager, {
                  get(target, property) {
                    if (property !== 'organizationMember')
                      return Reflect.get(target, property);
                    return new Proxy(target.organizationMember, {
                      get(delegate, method) {
                        if (method !== 'update')
                          return Reflect.get(delegate, method);
                        return async (
                          args: Prisma.OrganizationMemberUpdateArgs,
                        ) => {
                          await wait();
                          return delegate.update(args);
                        };
                      },
                    });
                  },
                }),
            ),
            new PermissionsService(db as unknown as PrismaService),
          );
          const results = await Promise.allSettled([
            ownership(pauseTransfer(wait)).transferForActor(
              regularId,
              organizationId,
              membershipId,
            ),
            removing.removeForActor(regularId, organizationId, membershipId),
          ]);
          expect(
            results.filter((result) => result.status === 'fulfilled'),
          ).toHaveLength(1);
          const org = await db.organization.findUniqueOrThrow({
            where: { id: organizationId },
          });
          expect(
            await db.organizationMember.count({
              where: {
                organizationId,
                userId: org.ownerId,
                status: 'ACTIVE',
                deletedAt: null,
              },
            }),
          ).toBe(1);
        });
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

        describe('Member role assignment', () => {
          const assignmentService = () =>
            new MemberRolesService(
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
          const permission = (resource: string, action: string) =>
            db.permission.findUniqueOrThrow({
              where: { action_resource: { resource, action } },
            });
          const custom = async (ids: string[] = []) =>
            roles().createForActor(regularId, organizationId, {
              name: 'ASSIGNABLE',
              permissionIds: ids,
            });
          const assign = (
            id: string,
            actorId = regularId,
            targetId = membershipId,
          ) =>
            assignmentService().assignForActor(
              actorId,
              organizationId,
              targetId,
              id,
            );
          const revoke = (
            id: string,
            actorId = regularId,
            targetId = membershipId,
          ) =>
            assignmentService().revokeForActor(
              actorId,
              organizationId,
              targetId,
              id,
            );
          const grant = async (action: string) => {
            const selected = await permission('ORGANIZATION_ROLE', action);
            await db.rolePermission.upsert({
              where: {
                roleId_permissionId: { roleId, permissionId: selected.id },
              },
              create: { roleId, permissionId: selected.id },
              update: { deletedAt: null },
            });
          };

          it('declares separate assign/revoke policies and forwards authenticated IDs through the controller', async () => {
            const reflector = new Reflector();
            for (const [method, action] of [
              ['assign', 'assign'],
              ['revoke', 'revoke'],
            ] as const) {
              expect(
                reflector.get(
                  'requiredOrganizationPermissions',
                  MemberRolesController.prototype[method],
                ),
              ).toMatchObject({
                permissions: [{ resource: 'ORGANIZATION_ROLE', action }],
                organizationIdParam: 'organizationId',
              });
            }
            const role = await custom();
            const controller = new MemberRolesController(assignmentService());
            await expect(
              controller.assign(
                regularId,
                organizationId,
                membershipId,
                role.id,
              ),
            ).resolves.toBeUndefined();
            expect(
              await db.memberRole.count({
                where: {
                  organizationMemberId: membershipId,
                  roleId: role.id,
                  deletedAt: null,
                },
              }),
            ).toBe(1);
            await controller.revoke(
              regularId,
              organizationId,
              membershipId,
              role.id,
            );
            expect(
              await db.memberRole.count({
                where: {
                  organizationMemberId: membershipId,
                  roleId: role.id,
                  deletedAt: null,
                },
              }),
            ).toBe(0);
          });

          it('never restores organization access when assignment races with member removal', async () => {
            const read = await permission('ORGANIZATION_MEMBER', 'read');
            const role = await custom([read.id]);
            const [removed, assigned] = await Promise.allSettled([
              members().removeForActor(regularId, organizationId, membershipId),
              assign(role.id),
            ]);
            expect(removed.status).toBe('fulfilled');
            if (assigned.status === 'rejected')
              expect(assigned.reason).toMatchObject({ status: 404 });
            await expect(
              organizations().currentPermissions(adminId, organizationId),
            ).rejects.toMatchObject({ status: 403 });
          });

          it('assigns and revokes one role while retaining the member and other assignments', async () => {
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const role = await custom([invite.id]);
            await assign(role.id);
            const original = await db.memberRole.findUniqueOrThrow({
              where: {
                organizationMemberId_roleId: {
                  organizationMemberId: membershipId,
                  roleId: role.id,
                },
              },
            });
            expect(
              (
                await organizations().currentPermissions(
                  adminId,
                  organizationId,
                )
              ).some((p) => p.id === invite.id),
            ).toBe(true);
            await revoke(role.id);
            const revoked = await db.memberRole.findUniqueOrThrow({
              where: { id: original.id },
            });
            expect(revoked.deletedAt).toBeInstanceOf(Date);
            expect(
              (
                await organizations().currentPermissions(
                  adminId,
                  organizationId,
                )
              ).some((p) => p.id === invite.id),
            ).toBe(false);
            expect(
              await db.memberRole.count({
                where: {
                  organizationMemberId: membershipId,
                  roleId,
                  deletedAt: null,
                },
              }),
            ).toBe(1);
            expect(
              (
                await db.organizationMember.findUniqueOrThrow({
                  where: { id: membershipId },
                })
              ).deletedAt,
            ).toBeNull();
            await assign(role.id);
            expect(
              await db.memberRole.findUniqueOrThrow({
                where: { id: original.id },
              }),
            ).toMatchObject({ deletedAt: null });
            expect(
              await db.memberRole.count({
                where: { organizationMemberId: membershipId, roleId: role.id },
              }),
            ).toBe(1);
          });

          it('promotes and demotes ADMIN only through owner actions, retaining MEMBER', async () => {
            const admin = await db.role.findFirstOrThrow({
              where: { organizationId, name: 'ADMIN' },
            });
            await assign(admin.id);
            await assign(roleId);
            expect(
              await db.memberRole.count({
                where: { organizationMemberId: membershipId, deletedAt: null },
              }),
            ).toBe(2);
            await grant('assign');
            await grant('revoke');
            await expect(assign(admin.id, adminId)).rejects.toMatchObject({
              status: 403,
            });
            await expect(revoke(admin.id, adminId)).rejects.toMatchObject({
              status: 403,
            });
            await revoke(admin.id);
            expect(
              await db.memberRole.count({
                where: {
                  organizationMemberId: membershipId,
                  roleId,
                  deletedAt: null,
                },
              }),
            ).toBe(1);
          });

          it('requires the matching assign or revoke permission without platform bypass', async () => {
            const role = await custom();
            for (const actor of [adminId, superId]) {
              await expect(assign(role.id, actor)).rejects.toMatchObject({
                status: 403,
              });
              await expect(revoke(role.id, actor)).rejects.toMatchObject({
                status: 403,
              });
            }
            await grant('assign');
            await expect(assign(role.id, adminId)).resolves.toBeUndefined();
            await expect(revoke(role.id, adminId)).rejects.toMatchObject({
              status: 403,
            });
          });

          it('limits custom-role assignment and revocation to the callers current grants', async () => {
            await grant('assign');
            await grant('revoke');
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            const role = await custom([invite.id]);
            await expect(assign(role.id, adminId)).rejects.toMatchObject({
              status: 403,
            });
            await assign(role.id);
            const other = await createUser();
            const otherMember = await db.organizationMember.create({
              data: { organizationId, userId: other.id },
            });
            await expect(
              assign(role.id, adminId, otherMember.id),
            ).resolves.toBeUndefined();
            await revoke(role.id);
            await expect(
              revoke(role.id, adminId, otherMember.id),
            ).rejects.toMatchObject({ status: 403 });
            await revoke(role.id, regularId, otherMember.id);
          });

          it('never treats OWNER as an assignable role', async () => {
            const ownerRole = await db.role.create({
              data: { organizationId, name: 'OWNER' },
            });
            await expect(assign(ownerRole.id)).rejects.toMatchObject({
              status: 403,
            });
            await expect(revoke(ownerRole.id)).rejects.toMatchObject({
              status: 403,
            });
          });

          it('rejects roles containing legacy platform or owner-only grants', async () => {
            const role = await custom();
            await db.rolePermission.create({
              data: { roleId: role.id, permissionId },
            });
            await expect(assign(role.id)).rejects.toMatchObject({
              status: 403,
            });
            await expect(revoke(role.id)).rejects.toMatchObject({
              status: 403,
            });
          });

          it('rejects cross-organization roles/members and system roles', async () => {
            const other = await organizations().create(regularId, {
              name: 'Other',
              slug: `assignment-${randomUUID()}`,
            });
            const foreignRole = await db.role.findFirstOrThrow({
              where: { organizationId: other.id, name: 'MEMBER' },
            });
            const foreignMember = await db.organizationMember.findUniqueOrThrow(
              {
                where: {
                  organizationId_userId: {
                    organizationId: other.id,
                    userId: regularId,
                  },
                },
              },
            );
            const role = await custom();
            await expect(assign(foreignRole.id)).rejects.toMatchObject({
              status: 404,
            });
            await expect(assign(superRoleId)).rejects.toMatchObject({
              status: 404,
            });
            await expect(
              assign(role.id, regularId, foreignMember.id),
            ).rejects.toMatchObject({ status: 404 });
            await expect(revoke(foreignRole.id)).rejects.toMatchObject({
              status: 404,
            });
          });

          it.each([
            'suspended member',
            'removed member',
            'deleted user',
            'deleted role',
          ])('rejects %s for assignment and revocation', async (kind) => {
            const role = await custom();
            if (kind === 'suspended member')
              await db.organizationMember.update({
                where: { id: membershipId },
                data: { status: 'SUSPENDED' },
              });
            if (kind === 'removed member')
              await db.organizationMember.update({
                where: { id: membershipId },
                data: { deletedAt: new Date() },
              });
            if (kind === 'deleted user')
              await db.user.update({
                where: { id: adminId },
                data: { deletedAt: new Date() },
              });
            if (kind === 'deleted role')
              await db.role.update({
                where: { id: role.id },
                data: { deletedAt: new Date() },
              });
            await expect(assign(role.id)).rejects.toMatchObject({
              status: 404,
            });
            await expect(revoke(role.id)).rejects.toMatchObject({
              status: 404,
            });
          });

          it('requires active caller membership and organization even for owners', async () => {
            const role = await custom();
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
            await expect(assign(role.id)).rejects.toMatchObject({
              status: 403,
            });
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: true },
            });
            await db.organizationMember.updateMany({
              where: { userId: regularId, organizationId },
              data: { status: 'SUSPENDED' },
            });
            await expect(revoke(role.id)).rejects.toMatchObject({
              status: 403,
            });
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
            await expect(assign(role.id)).rejects.toMatchObject({
              status: 401,
            });
          });

          it('makes repeated and concurrent requests idempotent without creating duplicate assignments', async () => {
            const role = await custom();
            await Promise.all([assign(role.id), assign(role.id)]);
            const where = {
              organizationMemberId: membershipId,
              roleId: role.id,
            };
            const original = await db.memberRole.findFirstOrThrow({ where });
            await assign(role.id);
            expect(
              (await db.memberRole.findFirstOrThrow({ where })).updatedAt,
            ).toEqual(original.updatedAt);
            await Promise.all([revoke(role.id), revoke(role.id)]);
            const revoked = await db.memberRole.findFirstOrThrow({ where });
            await revoke(role.id);
            expect(
              (await db.memberRole.findFirstOrThrow({ where })).deletedAt,
            ).toEqual(revoked.deletedAt);
            expect(await db.memberRole.count({ where })).toBe(1);
          });

          it('serializes concurrent assignment/revocation and never restores a deleted role', async () => {
            const role = await custom();
            await assign(role.id);
            await Promise.all([assign(role.id), revoke(role.id)]);
            expect(
              await db.memberRole.count({
                where: { organizationMemberId: membershipId, roleId: role.id },
              }),
            ).toBe(1);
            const [deleted, assigned] = await Promise.allSettled([
              roles().deleteForActor(regularId, organizationId, role.id),
              assign(role.id),
            ]);
            expect(deleted.status).toBe('fulfilled');
            if (assigned.status === 'rejected')
              expect(assigned.reason).toMatchObject({ status: 404 });
            const permissions = await organizations().currentPermissions(
              adminId,
              organizationId,
            );
            expect(permissions.some((p) => p.resource === 'USER')).toBe(false);
            expect(
              (await db.role.findUniqueOrThrow({ where: { id: role.id } }))
                .deletedAt,
            ).toBeInstanceOf(Date);
          });
        });

        describe('Custom role deletion', () => {
          const permission = (resource: string, action: string) =>
            db.permission.findUniqueOrThrow({
              where: { action_resource: { resource, action } },
            });
          const custom = async (permissionIds: string[] = []) =>
            roles().createForActor(regularId, organizationId, {
              name: 'REMOVABLE',
              permissionIds,
            });
          const remove = (id: string, actorId = regularId) =>
            roles().deleteForActor(actorId, organizationId, id);

          it('soft-deletes the role, preserves history and removes its effective grants', async () => {
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
            await remove(role.id);
            expect(
              await db.role.findUniqueOrThrow({ where: { id: role.id } }),
            ).toMatchObject({ deletedAt: expect.any(Date) });
            expect(
              await db.rolePermission.count({
                where: { roleId: role.id, deletedAt: null },
              }),
            ).toBe(1);
            expect(
              await db.memberRole.count({
                where: { roleId: role.id, deletedAt: null },
              }),
            ).toBe(1);
            expect(
              await permissions.hasOrganizationPermissions(
                adminId,
                organizationId,
                [invite],
              ),
            ).toBe(false);
            expect(
              (
                await organizations().currentPermissions(
                  adminId,
                  organizationId,
                )
              ).some((p) => p.id === invite.id),
            ).toBe(false);
            expect(
              (
                await roles().listForActor(regularId, organizationId, {})
              ).items.some((item) => item.id === role.id),
            ).toBe(false);
          });

          it('denies missing delete permission without platform bypass', async () => {
            const role = await custom();
            for (const actor of [adminId, superId])
              await expect(remove(role.id, actor)).rejects.toMatchObject({
                status: 403,
              });
          });

          it.each(['ADMIN', 'MEMBER', 'OWNER'])(
            'protects the built-in %s role',
            async (name) => {
              const role =
                name === 'OWNER'
                  ? await db.role.create({ data: { organizationId, name } })
                  : await db.role.findFirstOrThrow({
                      where: { organizationId, name },
                    });
              await expect(remove(role.id)).rejects.toMatchObject({
                status: 403,
              });
              expect(
                (await db.role.findUniqueOrThrow({ where: { id: role.id } }))
                  .deletedAt,
              ).toBeNull();
            },
          );

          it('scopes target lookup and preserves role-name reservation after deletion', async () => {
            const role = await custom();
            const other = await organizations().create(regularId, {
              name: 'Other',
              slug: `role-delete-${randomUUID()}`,
            });
            await expect(
              roles().deleteForActor(regularId, other.id, role.id),
            ).rejects.toMatchObject({ status: 404 });
            await expect(remove(randomUUID())).rejects.toMatchObject({
              status: 404,
            });
            await remove(role.id);
            await expect(custom()).rejects.toMatchObject({ status: 409 });
          });

          it('checks current grants before allowing deletion by non-owners', async () => {
            const canDelete = await permission('ORGANIZATION_ROLE', 'delete');
            const invite = await permission('ORGANIZATION_MEMBER', 'invite');
            await db.rolePermission.create({
              data: { roleId, permissionId: canDelete.id },
            });
            const role = await custom([invite.id]);
            await expect(remove(role.id, adminId)).rejects.toMatchObject({
              status: 403,
            });
            await db.rolePermission.create({
              data: { roleId, permissionId: invite.id },
            });
            await expect(remove(role.id, adminId)).resolves.toBeUndefined();
          });

          it('makes repeated and concurrent authorized deletes idempotent', async () => {
            const role = await custom();
            await Promise.all([remove(role.id), remove(role.id)]);
            const first = await db.role.findUniqueOrThrow({
              where: { id: role.id },
            });
            await remove(role.id);
            expect(
              (await db.role.findUniqueOrThrow({ where: { id: role.id } }))
                .deletedAt,
            ).toEqual(first.deletedAt);
          });

          it('does not resurrect a role during concurrent editing and deletion', async () => {
            const role = await custom();
            const [deleted, edited] = await Promise.allSettled([
              remove(role.id),
              roles().updateForActor(regularId, organizationId, role.id, {
                name: 'RENAMED',
              }),
            ]);
            expect(deleted.status).toBe('fulfilled');
            if (edited.status === 'rejected')
              expect(edited.reason).toMatchObject({ status: 404 });
            expect(
              (await db.role.findUniqueOrThrow({ where: { id: role.id } }))
                .deletedAt,
            ).toBeInstanceOf(Date);
          });

          it('requires current authorization even when the target is already deleted', async () => {
            const role = await custom();
            await remove(role.id);
            await db.organization.update({
              where: { id: organizationId },
              data: { isActive: false },
            });
            await expect(remove(role.id)).rejects.toMatchObject({
              status: 403,
            });
            await db.user.update({
              where: { id: regularId },
              data: { deletedAt: new Date() },
            });
            await expect(remove(role.id)).rejects.toMatchObject({
              status: 401,
            });
          });
        });

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
