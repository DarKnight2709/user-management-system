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
