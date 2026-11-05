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
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  clearOrganizationTables,
  createFixtureUser,
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import { OrganizationCreationService } from '../organization-creation.service.js';
import { OrganizationDeletionService } from '../organization-deletion.service.js';
import { OrganizationsService } from '../organizations.service.js';
import type { CreateOrganizationDto } from '../dto/create-organization.dto.js';
import type { UpdateOrganizationDto } from '../dto/update-organization.dto.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const newOrganization = (slug = `org-${randomUUID()}`) =>
  ({ name: 'Integration Org', slug }) as CreateOrganizationDto;
const renameTo = (name: string) => ({ name }) as UpdateOrganizationDto;

describe.runIf(runDatabaseTests)('Organizations database integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let ownerId: string;
  let memberId: string;
  let outsiderId: string;
  let logging: {
    audit: ReturnType<typeof vi.fn>;
    publishCommittedAudit: ReturnType<typeof vi.fn>;
  };
  let creation: OrganizationCreationService;
  let deletion: OrganizationDeletionService;
  let organizations: OrganizationsService;

  const seedPermissions = () =>
    db.permission.createMany({
      data: [
        ...organizationPermissions.map(({ resource, action, description }) => ({
          resource,
          action,
          description,
        })),
        { resource: 'ORGANIZATION', action: 'delete' },
      ],
    });

  const addMember = async (userId: string, organizationId: string) =>
    db.organizationMember.create({ data: { organizationId, userId } });

  const assignRole = async (
    membershipId: string,
    organizationId: string,
    roleName: string,
  ) => {
    const role = await db.role.findFirstOrThrow({
      where: { organizationId, name: roleName },
    });
    await db.memberRole.create({
      data: { organizationMemberId: membershipId, roleId: role.id },
    });
  };

  const createOrganizationWithMember = async (roleName: string) => {
    const { id: organizationId } = await creation.createForActor(
      ownerId,
      newOrganization(),
    );
    const membership = await addMember(memberId, organizationId);
    await assignRole(membership.id, organizationId, roleName);
    return organizationId;
  };

  const grantPlatformDeletion = async (userId: string) => {
    const permission = await db.permission.findFirstOrThrow({
      where: { resource: 'ORGANIZATION', action: 'delete' },
    });
    const role = await db.role.create({
      data: {
        name: 'SUPER_ADMIN',
        isSystem: true,
        rolePermissions: { create: { permissionId: permission.id } },
      },
    });
    await db.userPlatformRole.create({ data: { userId, roleId: role.id } });
  };

  beforeAll(async () => {
    database = await createIsolatedDatabase('organizations');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await clearOrganizationTables(db);
    await seedPermissions();
    ownerId = (await createFixtureUser(db, 'owner')).id;
    memberId = (await createFixtureUser(db, 'member')).id;
    outsiderId = (await createFixtureUser(db, 'outsider')).id;

    logging = {
      audit: vi.fn().mockResolvedValue({ eventId: randomUUID() }),
      publishCommittedAudit: vi.fn(),
    };
    const permissions = new PermissionsService(
      database.prisma as PrismaService,
    );
    const loggingService = logging as unknown as LoggingService;
    creation = new OrganizationCreationService(
      database.prisma,
      permissions,
      loggingService,
    );
    deletion = new OrganizationDeletionService(
      database.prisma,
      permissions,
      loggingService,
    );
    organizations = new OrganizationsService(
      database.prisma,
      permissions,
      loggingService,
    );
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe('create', () => {
    it('provisions the organization, owner membership and default roles atomically', async () => {
      const created = await creation.createForActor(ownerId, newOrganization());

      await expect(
        db.organization.findUniqueOrThrow({ where: { id: created.id } }),
      ).resolves.toMatchObject({ ownerId, isActive: true, deletedAt: null });
      await expect(
        db.organizationMember.findFirstOrThrow({
          where: { organizationId: created.id, userId: ownerId },
        }),
      ).resolves.toMatchObject({ status: 'ACTIVE', deletedAt: null });
      const roles = await db.role.findMany({
        where: { organizationId: created.id },
        orderBy: { name: 'asc' },
      });
      expect(roles.map(({ name }) => name)).toEqual(['ADMIN', 'MEMBER']);
      expect(roles.every(({ isSystem }) => !isSystem)).toBe(true);
    });

    it('grants ADMIN seven permissions and MEMBER three read-only ones', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());

      const grantsOf = async (name: string) =>
        (
          await db.rolePermission.findMany({
            where: { role: { organizationId: id, name }, deletedAt: null },
            include: { permission: true },
          })
        )
          .map(
            ({ permission }) => `${permission.resource}:${permission.action}`,
          )
          .sort();

      await expect(grantsOf('ADMIN')).resolves.toHaveLength(7);
      await expect(grantsOf('MEMBER')).resolves.toEqual([
        'ORGANIZATION:read',
        'ORGANIZATION_MEMBER:read',
        'ORGANIZATION_ROLE:read',
      ]);
    });

    it('does not assign any role to the owner', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());

      await expect(
        db.memberRole.count({
          where: { organizationMember: { organizationId: id } },
        }),
      ).resolves.toBe(0);
    });

    it('publishes the audit event once after commit', async () => {
      await creation.createForActor(ownerId, newOrganization());

      expect(logging.audit).toHaveBeenCalledOnce();
      expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
    });

    it('rejects unknown and deleted accounts with 401', async () => {
      const deletedUser = await createFixtureUser(db, 'deleted');
      await db.user.update({
        where: { id: deletedUser.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        creation.createForActor(randomUUID(), newOrganization()),
      ).rejects.toMatchObject({ status: 401 });
      await expect(
        creation.createForActor(deletedUser.id, newOrganization()),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('keeps slugs reserved, even after the organization is deleted', async () => {
      const slug = `taken-${randomUUID()}`;
      const { id } = await creation.createForActor(
        ownerId,
        newOrganization(slug),
      );

      await expect(
        creation.createForActor(memberId, newOrganization(slug)),
      ).rejects.toMatchObject({ status: 409 });
      await deletion.deleteForActor(ownerId, id);
      await expect(
        creation.createForActor(memberId, newOrganization(slug)),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('rolls back everything when a default permission is unavailable', async () => {
      await db.permission.updateMany({
        where: { resource: 'ORGANIZATION_AUDIT_LOG' },
        data: { deletedAt: new Date() },
      });

      await expect(
        creation.createForActor(ownerId, newOrganization()),
      ).rejects.toMatchObject({ status: 503 });

      await expect(db.organization.count()).resolves.toBe(0);
      await expect(db.role.count()).resolves.toBe(0);
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('lets only one concurrent request claim a slug', async () => {
      const slug = `race-${randomUUID()}`;

      const outcomes = await Promise.allSettled([
        creation.createForActor(ownerId, newOrganization(slug)),
        creation.createForActor(memberId, newOrganization(slug)),
      ]);

      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      await expect(db.organization.count({ where: { slug } })).resolves.toBe(1);
    });
  });

  describe('read', () => {
    it('shows an organization to its owner and any member with read access', async () => {
      const organizationId = await createOrganizationWithMember('MEMBER');

      await expect(
        organizations.findOneForActor(ownerId, organizationId),
      ).resolves.toMatchObject({ id: organizationId, ownerId });
      await expect(
        organizations.findOneForActor(memberId, organizationId),
      ).resolves.toMatchObject({ id: organizationId });
    });

    it('answers 403 for outsiders and for organizations that do not exist', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());

      await expect(
        organizations.findOneForActor(outsiderId, id),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        organizations.findOneForActor(ownerId, randomUUID()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('does not show members without a granting role', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await addMember(memberId, id);

      await expect(
        organizations.findOneForActor(memberId, id),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('does not show suspended or removed members', async () => {
      const organizationId = await createOrganizationWithMember('MEMBER');
      await db.organizationMember.updateMany({
        where: { organizationId, userId: memberId },
        data: { status: 'SUSPENDED' },
      });

      await expect(
        organizations.findOneForActor(memberId, organizationId),
      ).rejects.toMatchObject({ status: 403 });

      await db.organizationMember.updateMany({
        where: { organizationId, userId: memberId },
        data: { status: 'ACTIVE', deletedAt: new Date() },
      });
      await expect(
        organizations.findOneForActor(memberId, organizationId),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('lists only organizations the actor may read, newest first', async () => {
      const first = await creation.createForActor(ownerId, newOrganization());
      const second = await creation.createForActor(ownerId, newOrganization());
      await creation.createForActor(outsiderId, newOrganization());

      const page = await organizations.findAllForActor({ actorId: ownerId });

      expect(page.total).toBe(2);
      expect(page.items.map(({ id }) => id)).toEqual([second.id, first.id]);
    });

    it('excludes deleted and inactive organizations from the list', async () => {
      const deleted = await creation.createForActor(ownerId, newOrganization());
      const suspended = await creation.createForActor(
        ownerId,
        newOrganization(),
      );
      const active = await creation.createForActor(ownerId, newOrganization());
      await deletion.deleteForActor(ownerId, deleted.id);
      await db.organization.update({
        where: { id: suspended.id },
        data: { isActive: false },
      });

      const page = await organizations.findAllForActor({ actorId: ownerId });

      expect(page.items.map(({ id }) => id)).toEqual([active.id]);
    });

    it('returns an empty page for users with no organizations', async () => {
      await creation.createForActor(ownerId, newOrganization());

      await expect(
        organizations.findAllForActor({ actorId: outsiderId }),
      ).resolves.toEqual({ items: [], total: 0, page: 1, limit: 20 });
    });

    it('paginates with a stable total', async () => {
      for (let index = 0; index < 3; index += 1) {
        await creation.createForActor(ownerId, newOrganization());
      }

      const secondPage = await organizations.findAllForActor({
        actorId: ownerId,
        page: 2,
        limit: 2,
      });

      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.total).toBe(3);
    });
  });

  describe('update', () => {
    it('lets the owner rename the organization and nothing else', async () => {
      const { id, slug } = await creation.createForActor(
        ownerId,
        newOrganization(),
      );

      await expect(
        organizations.updateForActor(ownerId, id, renameTo('Renamed')),
      ).resolves.toMatchObject({ name: 'Renamed', slug, ownerId });
      expect(logging.publishCommittedAudit).toHaveBeenCalledTimes(2);
    });

    it('lets a member with the default ADMIN role rename the organization', async () => {
      const organizationId = await createOrganizationWithMember('ADMIN');

      await expect(
        organizations.updateForActor(
          memberId,
          organizationId,
          renameTo('Team'),
        ),
      ).resolves.toMatchObject({ name: 'Team' });
    });

    it('denies members whose roles cannot update', async () => {
      const organizationId = await createOrganizationWithMember('MEMBER');

      await expect(
        organizations.updateForActor(
          memberId,
          organizationId,
          renameTo('Nope'),
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      ).resolves.toMatchObject({ name: 'Integration Org' });
    });

    it('does not audit a rename to the same name', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      logging.audit.mockClear();
      logging.publishCommittedAudit.mockClear();

      await organizations.updateForActor(
        ownerId,
        id,
        renameTo('Integration Org'),
      );

      expect(logging.audit).not.toHaveBeenCalled();
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('does not update deleted organizations', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await deletion.deleteForActor(ownerId, id);

      await expect(
        organizations.updateForActor(ownerId, id, renameTo('Zombie')),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('delete', () => {
    it('soft-deletes the organization and revokes pending invitations only', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      const invitation = (email: string, status: 'PENDING' | 'ACCEPTED') =>
        db.organizationInvitation.create({
          data: {
            organizationId: id,
            email,
            tokenHash: randomUUID(),
            status,
            expiresAt: new Date(Date.now() + 86_400_000),
            invitedById: ownerId,
          },
        });
      const pending = await invitation('pending@example.com', 'PENDING');
      const accepted = await invitation('accepted@example.com', 'ACCEPTED');

      await deletion.deleteForActor(ownerId, id);

      await expect(
        db.organization.findUniqueOrThrow({ where: { id } }),
      ).resolves.toMatchObject({
        isActive: false,
        deletedAt: expect.any(Date),
      });
      await expect(
        db.organizationInvitation.findUniqueOrThrow({
          where: { id: pending.id },
        }),
      ).resolves.toMatchObject({ status: 'REVOKED' });
      await expect(
        db.organizationInvitation.findUniqueOrThrow({
          where: { id: accepted.id },
        }),
      ).resolves.toMatchObject({ status: 'ACCEPTED' });
    });

    it('retains memberships, roles and users', async () => {
      const organizationId = await createOrganizationWithMember('MEMBER');

      await deletion.deleteForActor(ownerId, organizationId);

      await expect(
        db.organizationMember.count({
          where: { organizationId, deletedAt: null },
        }),
      ).resolves.toBe(2);
      await expect(
        db.role.count({ where: { organizationId, deletedAt: null } }),
      ).resolves.toBe(2);
      await expect(db.user.count({ where: { deletedAt: null } })).resolves.toBe(
        3,
      );
    });

    it('keeps the original deletion time on repeated requests', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await deletion.deleteForActor(ownerId, id);
      const first = await db.organization.findUniqueOrThrow({ where: { id } });
      logging.publishCommittedAudit.mockClear();

      await deletion.deleteForActor(ownerId, id);
      const second = await db.organization.findUniqueOrThrow({ where: { id } });

      expect(second.deletedAt).toEqual(first.deletedAt);
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('denies ADMIN members and outsiders', async () => {
      const organizationId = await createOrganizationWithMember('ADMIN');

      await expect(
        deletion.deleteForActor(memberId, organizationId),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        deletion.deleteForActor(outsiderId, organizationId),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        db.organization.findUniqueOrThrow({ where: { id: organizationId } }),
      ).resolves.toMatchObject({ deletedAt: null });
    });

    it('denies an owner whose membership was removed', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await db.organizationMember.updateMany({
        where: { organizationId: id, userId: ownerId },
        data: { deletedAt: new Date() },
      });

      await expect(deletion.deleteForActor(ownerId, id)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('lets platform deleters delete without membership', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await grantPlatformDeletion(outsiderId);

      await deletion.deleteForActor(outsiderId, id);

      await expect(
        db.organization.findUniqueOrThrow({ where: { id } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('reveals missing organizations only to platform deleters', async () => {
      await grantPlatformDeletion(outsiderId);

      await expect(
        deletion.deleteForActor(outsiderId, randomUUID()),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        deletion.deleteForActor(memberId, randomUUID()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('lets the owner delete an inactive organization', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await db.organization.update({
        where: { id },
        data: { isActive: false },
      });

      await deletion.deleteForActor(ownerId, id);

      await expect(
        db.organization.findUniqueOrThrow({ where: { id } }),
      ).resolves.toMatchObject({ deletedAt: expect.any(Date) });
    });

    it('rejects deleted accounts with 401', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await db.user.update({
        where: { id: ownerId },
        data: { deletedAt: new Date() },
      });

      await expect(deletion.deleteForActor(ownerId, id)).rejects.toMatchObject({
        status: 401,
      });
    });
  });

  describe('current permissions', () => {
    it('gives owners the full organization catalog', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());

      const effective = await organizations.currentPermissions(ownerId, id);

      expect(effective).toHaveLength(organizationPermissions.length);
    });

    it('gives members the grants of their active roles only', async () => {
      const organizationId = await createOrganizationWithMember('MEMBER');

      const effective = await organizations.currentPermissions(
        memberId,
        organizationId,
      );

      expect(
        effective.map(({ resource, action }) => `${resource}:${action}`).sort(),
      ).toEqual([
        'ORGANIZATION:read',
        'ORGANIZATION_MEMBER:read',
        'ORGANIZATION_ROLE:read',
      ]);
    });

    it('returns an empty list for a member without roles', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());
      await addMember(memberId, id);

      await expect(
        organizations.currentPermissions(memberId, id),
      ).resolves.toEqual([]);
    });

    it('denies outsiders', async () => {
      const { id } = await creation.createForActor(ownerId, newOrganization());

      await expect(
        organizations.currentPermissions(outsiderId, id),
      ).rejects.toMatchObject({ status: 403 });
    });
  });
});
