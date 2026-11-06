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
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import type { PrismaClient } from '@/generated/prisma/client.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  clearOrganizationTables,
  createFixtureUser,
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import { AuditEventReader } from '../audit-event-reader.service.js';
import { AuditLogsService } from '../audit-logs.service.js';
import { AuditViewRecorder } from '../audit-view-recorder.service.js';
import { OrganizationAuditAccessService } from '../organization-audit-access.service.js';
import type {
  ListOrganizationAuditEventsQueryDto,
  ListPlatformAuditEventsQueryDto,
} from '../dto/list-audit-events-query.dto.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const platformQuery = (overrides = {}) =>
  ({ page: 1, limit: 20, ...overrides }) as ListPlatformAuditEventsQueryDto;
const organizationQuery = (overrides = {}) =>
  ({ page: 1, limit: 20, ...overrides }) as ListOrganizationAuditEventsQueryDto;

describe.runIf(runDatabaseTests)('Audit logs database integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let service: AuditLogsService;
  let winstonLog: ReturnType<typeof vi.fn>;
  let ownerId: string;
  let adminId: string;
  let memberId: string;
  let outsiderId: string;
  let platformAdminId: string;
  let organizationId: string;
  let otherOrganizationId: string;

  const permission = (resource: string, action: string) =>
    db.permission.upsert({
      where: { action_resource: { action, resource } },
      create: { resource, action },
      update: {},
    });

  const createOrganization = (ownerUserId: string) =>
    db.organization
      .create({
        data: {
          name: 'Org',
          slug: `org-${randomUUID()}`,
          ownerId: ownerUserId,
        },
      })
      .then(async (organization) => {
        await db.organizationMember.create({
          data: { organizationId: organization.id, userId: ownerUserId },
        });
        return organization.id;
      });

  const addMember = async (
    userId: string,
    orgId: string,
    roleName?: string,
    grants: [string, string][] = [],
  ) => {
    const membership = await db.organizationMember.create({
      data: { organizationId: orgId, userId },
    });
    if (!roleName) return membership;
    const permissions = await Promise.all(
      grants.map(([r, a]) => permission(r, a)),
    );
    const role = await db.role.create({
      data: {
        name: roleName,
        organizationId: orgId,
        rolePermissions: {
          create: permissions.map(({ id }) => ({ permissionId: id })),
        },
      },
    });
    await db.memberRole.create({
      data: { organizationMemberId: membership.id, roleId: role.id },
    });
    return membership;
  };

  const grantPlatformAuditRead = async (userId: string) => {
    const audit = await permission('AUDIT_LOG', 'read');
    const role = await db.role.create({
      data: {
        name: `AUDITOR_${randomUUID()}`,
        isSystem: true,
        rolePermissions: { create: { permissionId: audit.id } },
      },
    });
    return db.userPlatformRole.create({ data: { userId, roleId: role.id } });
  };

  const insertEvent = (
    overrides: Partial<{
      action: string;
      actorId: string | null;
      organizationId: string | null;
      targetId: string;
      occurredAt: Date;
    }> = {},
  ) =>
    db.auditEvent.create({
      data: {
        eventId: randomUUID(),
        schemaVersion: 1,
        action: overrides.action ?? 'user.profile.updated',
        actorId: overrides.actorId ?? null,
        actorType: overrides.actorId === null ? 'ANONYMOUS' : 'USER',
        targetId: overrides.targetId ?? randomUUID(),
        targetType: 'USER',
        organizationId: overrides.organizationId ?? null,
        requestId: randomUUID(),
        occurredAt: overrides.occurredAt ?? new Date(),
        payload: {},
      },
    });

  const viewEvents = () =>
    db.auditEvent.findMany({ where: { action: 'audit.log.viewed' } });

  beforeAll(async () => {
    database = await createIsolatedDatabase('auditlogs');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await db.auditEvent.deleteMany();
    await clearOrganizationTables(db);
    ownerId = (await createFixtureUser(db, 'owner')).id;
    adminId = (await createFixtureUser(db, 'admin')).id;
    memberId = (await createFixtureUser(db, 'member')).id;
    outsiderId = (await createFixtureUser(db, 'outsider')).id;
    platformAdminId = (await createFixtureUser(db, 'platform')).id;

    organizationId = await createOrganization(ownerId);
    otherOrganizationId = await createOrganization(outsiderId);
    // The owner passes through ownerId, but the permission must still exist in the catalog.
    await permission('ORGANIZATION_AUDIT_LOG', 'read');

    winstonLog = vi.fn();
    const logging = new LoggingService(
      { on: vi.fn(), off: vi.fn(), log: winstonLog } as unknown as Logger,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    const permissions = new PermissionsService(
      database.prisma as PrismaService,
    );
    service = new AuditLogsService(
      database.prisma,
      permissions,
      new OrganizationAuditAccessService(permissions),
      new AuditEventReader(),
      new AuditViewRecorder(logging),
    );
  });

  afterAll(async () => {
    await database?.dispose();
  });

  describe('platform history', () => {
    it('requires platform AUDIT_LOG read', async () => {
      await expect(
        service.listPlatform(ownerId, platformQuery()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(viewEvents()).resolves.toHaveLength(0);
    });

    it('rejects deleted actors', async () => {
      await grantPlatformAuditRead(platformAdminId);
      await db.user.update({
        where: { id: platformAdminId },
        data: { deletedAt: new Date() },
      });

      await expect(
        service.listPlatform(platformAdminId, platformQuery()),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('ignores revoked platform assignments', async () => {
      const assignment = await grantPlatformAuditRead(platformAdminId);
      await db.userPlatformRole.update({
        where: { id: assignment.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        service.listPlatform(platformAdminId, platformQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('is not granted by organization ownership or admin roles', async () => {
      await addMember(adminId, organizationId, 'ADMIN', [
        ['ORGANIZATION_AUDIT_LOG', 'read'],
      ]);

      await expect(
        service.listPlatform(adminId, platformQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('returns events across organizations, newest first', async () => {
      await grantPlatformAuditRead(platformAdminId);
      const oldest = await insertEvent({
        organizationId,
        occurredAt: new Date('2024-01-01'),
      });
      const newest = await insertEvent({
        organizationId: otherOrganizationId,
        occurredAt: new Date('2026-01-01'),
      });

      const page = await service.listPlatform(platformAdminId, platformQuery());

      const ids = page.items.map(({ eventId }) => eventId);
      expect(ids.indexOf(newest.eventId)).toBeLessThan(
        ids.indexOf(oldest.eventId),
      );
      expect(page.items.map(({ organizationId: o }) => o)).toEqual(
        expect.arrayContaining([organizationId, otherOrganizationId]),
      );
    });

    it('applies action, actor, target and organization filters', async () => {
      await grantPlatformAuditRead(platformAdminId);
      const targetId = randomUUID();
      const match = await insertEvent({
        action: 'user.deleted',
        actorId: ownerId,
        targetId,
        organizationId,
      });
      await insertEvent({ action: 'user.deleted', actorId: memberId });
      await insertEvent({ action: 'user.profile.updated', actorId: ownerId });

      const page = await service.listPlatform(
        platformAdminId,
        platformQuery({
          action: 'user.deleted',
          actorId: ownerId,
          targetId,
          targetType: 'USER',
          organizationId,
        }),
      );

      expect(page.items.map(({ eventId }) => eventId)).toEqual([match.eventId]);
      expect(page.total).toBe(1);
    });

    it('pages deterministically with a stable total', async () => {
      await grantPlatformAuditRead(platformAdminId);
      const stamp = new Date('2025-05-05');
      for (let i = 0; i < 5; i += 1) await insertEvent({ occurredAt: stamp });

      const first = await service.listPlatform(
        platformAdminId,
        platformQuery({ page: 1, limit: 3, action: 'user.profile.updated' }),
      );
      const second = await service.listPlatform(
        platformAdminId,
        platformQuery({ page: 2, limit: 3, action: 'user.profile.updated' }),
      );

      const all = [...first.items, ...second.items].map((e) => e.eventId);
      expect(new Set(all).size).toBe(5);
      expect(first.total).toBe(5);
      expect(second.items).toHaveLength(2);
    });

    it('records each read as audit.log.viewed in the database and Winston', async () => {
      await grantPlatformAuditRead(platformAdminId);

      await service.listPlatform(
        platformAdminId,
        platformQuery({ action: 'user.deleted' }),
      );

      const [view] = await viewEvents();
      expect(view).toMatchObject({
        actorId: platformAdminId,
        targetType: 'AUDIT_LOG',
        organizationId: null,
        payload: {
          scope: 'PLATFORM',
          page: 1,
          limit: 20,
          actionFilter: 'user.deleted',
        },
      });
      expect(winstonLog).toHaveBeenCalledOnce();
    });

    it('does not include the read it is recording in its own page', async () => {
      await grantPlatformAuditRead(platformAdminId);

      const page = await service.listPlatform(platformAdminId, platformQuery());

      expect(
        page.items.some(({ action }) => action === 'audit.log.viewed'),
      ).toBe(false);
      const second = await service.listPlatform(
        platformAdminId,
        platformQuery(),
      );
      expect(
        second.items.some(({ action }) => action === 'audit.log.viewed'),
      ).toBe(true);
    });
  });

  describe('organization history', () => {
    it('lets the owner read only their organization', async () => {
      const mine = await insertEvent({ organizationId });
      const theirs = await insertEvent({ organizationId: otherOrganizationId });
      await insertEvent({ organizationId: null });

      const page = await service.listOrganization(
        ownerId,
        organizationId,
        organizationQuery(),
      );

      const ids = page.items.map(({ eventId }) => eventId);
      expect(ids).toContain(mine.eventId);
      expect(ids).not.toContain(theirs.eventId);
      expect(page.items.every((e) => e.organizationId === organizationId)).toBe(
        true,
      );
    });

    it('lets a built-in ADMIN with the audit permission read', async () => {
      await addMember(adminId, organizationId, 'ADMIN', [
        ['ORGANIZATION_AUDIT_LOG', 'read'],
      ]);

      await expect(
        service.listOrganization(adminId, organizationId, organizationQuery()),
      ).resolves.toMatchObject({ page: 1 });
    });

    it('denies a custom role even with the audit permission', async () => {
      await addMember(memberId, organizationId, 'AUDITOR', [
        ['ORGANIZATION_AUDIT_LOG', 'read'],
      ]);

      await expect(
        service.listOrganization(memberId, organizationId, organizationQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('denies a built-in ADMIN whose audit grant was removed', async () => {
      await addMember(adminId, organizationId, 'ADMIN', []);

      await expect(
        service.listOrganization(adminId, organizationId, organizationQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('denies outsiders, including the owner of another organization', async () => {
      await expect(
        service.listOrganization(
          outsiderId,
          organizationId,
          organizationQuery(),
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('gives platform auditors no organization bypass', async () => {
      await grantPlatformAuditRead(platformAdminId);

      await expect(
        service.listOrganization(
          platformAdminId,
          organizationId,
          organizationQuery(),
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('denies suspended and removed members', async () => {
      const membership = await addMember(adminId, organizationId, 'ADMIN', [
        ['ORGANIZATION_AUDIT_LOG', 'read'],
      ]);
      await db.organizationMember.update({
        where: { id: membership.id },
        data: { deletedAt: new Date() },
      });

      await expect(
        service.listOrganization(adminId, organizationId, organizationQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('denies everyone once the organization is deleted', async () => {
      await db.organization.update({
        where: { id: organizationId },
        data: { deletedAt: new Date(), isActive: false },
      });

      await expect(
        service.listOrganization(ownerId, organizationId, organizationQuery()),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('rejects deleted actors with 401', async () => {
      await db.user.update({
        where: { id: ownerId },
        data: { deletedAt: new Date() },
      });

      await expect(
        service.listOrganization(ownerId, organizationId, organizationQuery()),
      ).rejects.toMatchObject({ status: 401 });
    });

    it('records the view against the route organization', async () => {
      await service.listOrganization(
        ownerId,
        organizationId,
        organizationQuery({ action: 'audit.log.viewed' }),
      );

      const [view] = await viewEvents();
      expect(view).toMatchObject({
        actorId: ownerId,
        organizationId,
        payload: {
          scope: 'ORGANIZATION',
          actionFilter: 'audit.log.viewed',
        },
      });
    });

    it('records nothing for a denied read', async () => {
      await expect(
        service.listOrganization(
          outsiderId,
          organizationId,
          organizationQuery(),
        ),
      ).rejects.toBeDefined();

      await expect(viewEvents()).resolves.toHaveLength(0);
      expect(winstonLog).not.toHaveBeenCalled();
    });
  });

  it('fails the read, stores no view and logs no copy when auditing fails', async () => {
    await grantPlatformAuditRead(platformAdminId);
    const failing = new AuditLogsService(
      database.prisma,
      new PermissionsService(database.prisma as PrismaService),
      new OrganizationAuditAccessService(
        new PermissionsService(database.prisma as PrismaService),
      ),
      new AuditEventReader(),
      {
        recordPlatformView: vi.fn().mockRejectedValue(new Error('audit down')),
        publish: vi.fn(),
      } as unknown as AuditViewRecorder,
    );

    await expect(
      failing.listPlatform(platformAdminId, platformQuery()),
    ).rejects.toThrow('audit down');
    await expect(viewEvents()).resolves.toHaveLength(0);
  });
});
