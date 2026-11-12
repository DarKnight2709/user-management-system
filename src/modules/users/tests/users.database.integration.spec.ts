import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import type { S3Service } from '@/core/storage/s3.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import type { EmailVerificationService } from '@/modules/account-security/services/email-verification.service.js';
import {
  clearOrganizationTables,
  createFixtureUser,
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import { UserDeletionService } from '../user-deletion.service.js';
import { UsersService } from '../users.service.js';
import type { UpdateUserDto } from '../dto/user.dto.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

describe.runIf(runDatabaseTests)('Users database integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let adminId: string;
  let userId: string;
  let otherId: string;
  let logging: {
    audit: ReturnType<typeof vi.fn>;
    publishCommittedAudit: ReturnType<typeof vi.fn>;
  };
  let users: UsersService;
  let deletion: UserDeletionService;

  /** Gives the user a system platform role holding the given permissions. */
  const grantPlatform = async (
    id: string,
    roleName: string,
    grants: { resource: string; action: string }[],
  ) => {
    const permissions = await Promise.all(
      grants.map(({ resource, action }) =>
        db.permission.upsert({
          where: { action_resource: { action, resource } },
          create: { resource, action },
          update: {},
        }),
      ),
    );
    const role = await db.role.create({
      data: {
        name: roleName,
        isSystem: true,
        rolePermissions: {
          create: permissions.map(({ id: permissionId }) => ({
            permissionId,
          })),
        },
      },
    });
    return db.userPlatformRole.create({
      data: { userId: id, roleId: role.id },
    });
  };

  const createOrganization = (ownerId: string, deletedAt: Date | null = null) =>
    db.organization.create({
      data: {
        name: 'Org',
        slug: `org-${randomUUID()}`,
        ownerId,
        deletedAt,
        isActive: deletedAt === null,
      },
    });

  const createRefreshToken = (id: string) =>
    db.refreshToken.create({
      data: {
        refreshTokenHash: randomUUID(),
        userId: id,
        familyId: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  beforeAll(async () => {
    database = await createIsolatedDatabase('users');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await clearOrganizationTables(db);
    adminId = (await createFixtureUser(db, 'admin')).id;
    userId = (await createFixtureUser(db, 'user')).id;
    otherId = (await createFixtureUser(db, 'other')).id;

    logging = {
      audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
      publishCommittedAudit: vi.fn(),
    };
    const permissions = new PermissionsService(
      database.prisma as PrismaService,
    );
    const loggingService = logging as unknown as LoggingService;
    const s3 = {
      getPublicUrl: (key: string | null) =>
        key ? `https://cdn.test/${key}` : null,
    } as unknown as S3Service;
    // Email verification has its own integration spec; here it is a stand-in.
    const emailVerification = {
      issueFor: vi.fn().mockResolvedValue({ id: randomUUID() }),
      enqueue: vi.fn().mockResolvedValue(true),
    } as unknown as EmailVerificationService;
    users = new UsersService(
      database.prisma,
      s3,
      permissions,
      loggingService,
      emailVerification,
    );
    deletion = new UserDeletionService(
      database.prisma,
      permissions,
      loggingService,
    );
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe('findAllForActor', () => {
    it('requires platform USER:read', async () => {
      await expect(
        users.findAllForActor({ actorId: userId }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects deleted actors', async () => {
      await grantPlatform(adminId, 'ADMIN_READER', [
        { resource: 'USER', action: 'read' },
      ]);
      await db.user.update({
        where: { id: adminId },
        data: { deletedAt: new Date() },
      });

      await expect(
        users.findAllForActor({ actorId: adminId }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('ignores permissions from revoked assignments', async () => {
      const assignment = await grantPlatform(adminId, 'ADMIN_READER', [
        { resource: 'USER', action: 'read' },
      ]);
      await db.userPlatformRole.update({
        where: { id: assignment.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        users.findAllForActor({ actorId: adminId }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('lists active users, excluding deleted ones and secrets', async () => {
      await grantPlatform(adminId, 'ADMIN_READER', [
        { resource: 'USER', action: 'read' },
      ]);
      await db.user.update({
        where: { id: otherId },
        data: { deletedAt: new Date() },
      });

      const result = await users.findAllForActor({ actorId: adminId });

      expect(result.total).toBe(2);
      expect(result.items.map(({ id }) => id).sort()).toEqual(
        [adminId, userId].sort(),
      );
      for (const item of result.items) {
        expect(item).not.toHaveProperty('hashedPassword');
        expect(item).not.toHaveProperty('avatarKey');
      }
    });

    it('orders by newest first and pages without overlap', async () => {
      await grantPlatform(adminId, 'ADMIN_READER', [
        { resource: 'USER', action: 'read' },
      ]);
      await db.user.update({
        where: { id: adminId },
        data: { createdAt: new Date('2020-01-01') },
      });
      await db.user.update({
        where: { id: userId },
        data: { createdAt: new Date('2022-01-01') },
      });
      await db.user.update({
        where: { id: otherId },
        data: { createdAt: new Date('2024-01-01') },
      });

      const first = await users.findAllForActor({
        actorId: adminId,
        page: 1,
        limit: 2,
      });
      const second = await users.findAllForActor({
        actorId: adminId,
        page: 2,
        limit: 2,
      });

      expect(first.items.map(({ id }) => id)).toEqual([otherId, userId]);
      expect(second.items.map(({ id }) => id)).toEqual([adminId]);
      expect(second.total).toBe(3);
    });
  });

  describe('findOneForActor', () => {
    it('lets users read themselves without any role', async () => {
      await expect(
        users.findOneForActor({ actorId: userId, targetId: userId }),
      ).resolves.toMatchObject({ id: userId });
    });

    it('forbids reading another account without USER:read', async () => {
      await expect(
        users.findOneForActor({ actorId: userId, targetId: otherId }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('does not reveal missing targets to unauthorized callers', async () => {
      await expect(
        users.findOneForActor({ actorId: userId, targetId: randomUUID() }),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('returns 404 for missing and deleted targets to authorized callers', async () => {
      await grantPlatform(adminId, 'ADMIN_READER', [
        { resource: 'USER', action: 'read' },
      ]);
      await db.user.update({
        where: { id: otherId },
        data: { deletedAt: new Date() },
      });

      await expect(
        users.findOneForActor({ actorId: adminId, targetId: otherId }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        users.findOneForActor({ actorId: adminId, targetId: randomUUID() }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('omits the password hash and maps the avatar to a URL', async () => {
      await db.user.update({
        where: { id: userId },
        data: { avatarKey: 'me.jpg' },
      });

      const user = await users.findOneForActor({
        actorId: userId,
        targetId: userId,
      });

      expect(user).not.toHaveProperty('hashedPassword');
      expect(user.avatarUrl).toBe('https://cdn.test/me.jpg');
    });
  });

  describe('create and update', () => {
    const registration = () => ({
      firstName: 'New',
      lastName: 'User',
      birthDate: new Date('1999-05-05'),
      hashedPassword: 'hash',
      email: `New-${randomUUID()}@Example.com`,
      username: `New-${randomUUID()}`,
    });

    it('stores normalized identifiers and a registration audit event', async () => {
      const dto = registration();

      const created = await users.create(dto as never);

      const stored = await db.user.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(stored.email).toBe(dto.email.toLowerCase());
      expect(stored.username).toBe(dto.username.toLowerCase());
      expect(created).not.toHaveProperty('hashedPassword');
      expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
    });

    it('rejects a duplicate email and publishes nothing', async () => {
      const dto = registration();
      await users.create(dto as never);
      logging.publishCommittedAudit.mockClear();

      await expect(
        users.create({ ...registration(), email: dto.email } as never),
      ).rejects.toBeDefined();
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('updates only the profile and audits the changed fields', async () => {
      const current = await db.user.findUniqueOrThrow({
        where: { id: userId },
      });

      await users.update(userId, {
        username: current.username,
        email: current.email,
        firstName: 'Renamed',
        lastName: current.lastName,
        birthDate: current.birthDate,
      } as unknown as UpdateUserDto);

      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ firstName: 'Renamed' });
      expect(logging.audit).toHaveBeenCalledWith(
        expect.objectContaining({ payload: { changedFields: ['firstName'] } }),
        expect.anything(),
      );
    });

    it('does not update deleted users', async () => {
      const current = await db.user.update({
        where: { id: userId },
        data: { deletedAt: new Date() },
      });

      await expect(
        users.update(userId, {
          username: current.username,
          email: current.email,
          firstName: 'Ghost',
          lastName: current.lastName,
          birthDate: current.birthDate,
        } as unknown as UpdateUserDto),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('deletion', () => {
    it("soft-deletes the account and revokes only that user's sessions", async () => {
      await createRefreshToken(userId);
      await createRefreshToken(userId);
      await createRefreshToken(otherId);

      await deletion.delete({ actorId: userId, targetId: userId });

      const deleted = await db.user.findUniqueOrThrow({
        where: { id: userId },
      });
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      const tokens = await db.refreshToken.findMany({ where: { userId } });
      expect(tokens).toHaveLength(2);
      expect(tokens.every(({ revokedAt }) => revokedAt !== null)).toBe(true);
      await expect(
        db.refreshToken.findFirstOrThrow({ where: { userId: otherId } }),
      ).resolves.toMatchObject({ revokedAt: null });
      expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
    });

    it('lets an admin with USER:delete remove another user', async () => {
      await grantPlatform(adminId, 'USER_DELETER', [
        { resource: 'USER', action: 'delete' },
      ]);

      await deletion.delete({ actorId: adminId, targetId: userId });

      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('forbids deleting others without USER:delete and keeps the target', async () => {
      await expect(
        deletion.delete({ actorId: userId, targetId: otherId }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        db.user.findUniqueOrThrow({ where: { id: otherId } }),
      ).resolves.toMatchObject({ deletedAt: null });
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('rejects a deleted actor even for self-deletion retries', async () => {
      await deletion.delete({ actorId: userId, targetId: userId });

      await expect(
        deletion.delete({ actorId: userId, targetId: userId }),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('treats an authorized repeat deletion as a no-op keeping the timestamp', async () => {
      await grantPlatform(adminId, 'USER_DELETER', [
        { resource: 'USER', action: 'delete' },
      ]);
      await deletion.delete({ actorId: adminId, targetId: userId });
      const { deletedAt } = await db.user.findUniqueOrThrow({
        where: { id: userId },
      });
      logging.publishCommittedAudit.mockClear();

      await deletion.delete({ actorId: adminId, targetId: userId });

      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt });
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('returns 404 for a missing target only after authorization', async () => {
      await expect(
        deletion.delete({ actorId: userId, targetId: randomUUID() }),
      ).rejects.toMatchObject({ status: 403 });

      await grantPlatform(adminId, 'USER_DELETER', [
        { resource: 'USER', action: 'delete' },
      ]);
      await expect(
        deletion.delete({ actorId: adminId, targetId: randomUUID() }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('blocks owners of active and inactive organizations', async () => {
      const organization = await createOrganization(userId);

      await expect(
        deletion.delete({ actorId: userId, targetId: userId }),
      ).rejects.toMatchObject({ status: 409 });

      await db.organization.update({
        where: { id: organization.id },
        data: { isActive: false },
      });
      await expect(
        deletion.delete({ actorId: userId, targetId: userId }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('allows deletion once owned organizations are soft-deleted', async () => {
      await createOrganization(userId, new Date());

      await deletion.delete({ actorId: userId, targetId: userId });

      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('protects an active SUPER_ADMIN, even from self-deletion', async () => {
      await grantPlatform(adminId, 'SUPER_ADMIN', []);

      await expect(
        deletion.delete({ actorId: adminId, targetId: adminId }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        db.user.findUniqueOrThrow({ where: { id: adminId } }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('allows deleting a user whose SUPER_ADMIN assignment was revoked', async () => {
      const assignment = await grantPlatform(adminId, 'SUPER_ADMIN', []);
      await db.userPlatformRole.update({
        where: { id: assignment.id },
        data: { deletedAt: new Date() },
      });

      await deletion.delete({ actorId: adminId, targetId: adminId });

      await expect(
        db.user.findUniqueOrThrow({ where: { id: adminId } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('retains memberships and role assignments', async () => {
      const organization = await createOrganization(otherId);
      const membership = await db.organizationMember.create({
        data: { organizationId: organization.id, userId },
      });

      await deletion.delete({ actorId: userId, targetId: userId });

      await expect(
        db.organizationMember.findUniqueOrThrow({
          where: { id: membership.id },
        }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('rolls back account deletion when the audit write fails', async () => {
      await createRefreshToken(userId);
      logging.audit.mockRejectedValue(new Error('audit down'));

      await expect(
        deletion.delete({ actorId: userId, targetId: userId }),
      ).rejects.toThrow('audit down');

      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt: null });
      await expect(
        db.refreshToken.findFirstOrThrow({ where: { userId } }),
      ).resolves.toMatchObject({ revokedAt: null });
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('serializes concurrent deletions so the account is deleted once', async () => {
      await grantPlatform(adminId, 'USER_DELETER', [
        { resource: 'USER', action: 'delete' },
      ]);
      await createRefreshToken(userId);

      const results = await Promise.allSettled([
        deletion.delete({ actorId: userId, targetId: userId }),
        deletion.delete({ actorId: adminId, targetId: userId }),
      ]);

      // The self-deleting actor may legitimately lose the race with a 401.
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toMatchObject({ status: 401 });
        }
      }
      expect(results.some(({ status }) => status === 'fulfilled')).toBe(true);
      await expect(
        db.user.findUniqueOrThrow({ where: { id: userId } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
      expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
    });

    it('does not let a concurrent organization creation orphan a deleted owner', async () => {
      const outcomes = await Promise.allSettled([
        deletion.delete({ actorId: userId, targetId: userId }),
        database.prisma.serializableTransaction(async (manager) => {
          const owner = await manager.user.findFirst({
            where: { id: userId, deletedAt: null },
          });
          if (!owner) throw new Error('owner deleted');
          return manager.organization.create({
            data: {
              name: 'Raced',
              slug: `raced-${randomUUID()}`,
              ownerId: userId,
            },
          });
        }),
      ]);

      const deleted =
        (await db.user.findUniqueOrThrow({ where: { id: userId } }))
          .deletedAt !== null;
      const ownsOrganization =
        (await db.organization.count({
          where: { ownerId: userId, deletedAt: null },
        })) > 0;
      expect(outcomes).toHaveLength(2);
      expect(deleted && ownsOrganization).toBe(false);
    });
  });
});
