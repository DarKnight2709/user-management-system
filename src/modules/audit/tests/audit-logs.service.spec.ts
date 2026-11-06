import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { AuditEventReader } from '../services/audit-event-reader.service.js';
import { AuditLogsService } from '../audit-logs.service.js';
import { AuditViewRecorder } from '../services/audit-view-recorder.service.js';
import { OrganizationAuditAccessService } from '../services/organization-audit-access.service.js';
import type {
  ListOrganizationAuditEventsQueryDto,
  ListPlatformAuditEventsQueryDto,
} from '../dto/list-audit-events-query.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';

const platformQuery = (overrides = {}) =>
  ({ page: 1, limit: 20, ...overrides }) as ListPlatformAuditEventsQueryDto;
const organizationQuery = (overrides = {}) =>
  ({ page: 1, limit: 20, ...overrides }) as ListOrganizationAuditEventsQueryDto;

function setup() {
  const manager = {};
  const page = { items: [{ eventId: 'e1' }], total: 1, page: 1, limit: 20 };
  const stored = { eventId: 'view' };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasPlatformPermission: vi.fn().mockResolvedValue(true),
  };
  const access = { assertCanRead: vi.fn().mockResolvedValue(undefined) };
  const reader = { readPage: vi.fn().mockResolvedValue(page) };
  const views = {
    recordPlatformView: vi.fn().mockResolvedValue(stored),
    recordOrganizationView: vi.fn().mockResolvedValue(stored),
    publish: vi.fn(),
  };
  const prisma = createPrismaStub(manager);
  const service = new AuditLogsService(
    prisma,
    permissions as unknown as PermissionsService,
    access as unknown as OrganizationAuditAccessService,
    reader as unknown as AuditEventReader,
    views as unknown as AuditViewRecorder,
  );
  return { service, manager, page, stored, permissions, access, reader, views };
}

describe('AuditLogsService.listPlatform', () => {
  it('rejects inactive actors before reading anything', async () => {
    const ctx = setup();
    ctx.permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      ctx.service.listPlatform(actorId, platformQuery()),
    ).rejects.toMatchObject({ status: 401 });
    expect(ctx.reader.readPage).not.toHaveBeenCalled();
  });

  it('requires platform AUDIT_LOG read with the transaction client', async () => {
    const ctx = setup();
    ctx.permissions.hasPlatformPermission.mockResolvedValue(false);

    await expect(
      ctx.service.listPlatform(actorId, platformQuery()),
    ).rejects.toMatchObject({ status: 403 });
    expect(ctx.permissions.hasPlatformPermission).toHaveBeenCalledWith(
      actorId,
      { resource: 'AUDIT_LOG', action: 'read' },
      ctx.manager,
    );
    expect(ctx.reader.readPage).not.toHaveBeenCalled();
    expect(ctx.views.recordPlatformView).not.toHaveBeenCalled();
    expect(ctx.views.publish).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0, limit: 20 },
    { page: 1, limit: 101 },
    { page: 1.5, limit: 20 },
  ])('rejects invalid pagination %j before the transaction', async (bad) => {
    const ctx = setup();

    await expect(
      ctx.service.listPlatform(actorId, platformQuery(bad)),
    ).rejects.toMatchObject({ status: 422 });
    expect(ctx.permissions.assertActiveActor).not.toHaveBeenCalled();
  });

  it('reads the page, records the view and publishes after commit', async () => {
    const ctx = setup();
    const query = platformQuery({ action: 'user.deleted' });

    await expect(ctx.service.listPlatform(actorId, query)).resolves.toBe(
      ctx.page,
    );

    expect(ctx.reader.readPage).toHaveBeenCalledWith(ctx.manager, query);
    expect(ctx.views.recordPlatformView).toHaveBeenCalledWith(
      ctx.manager,
      actorId,
      expect.any(String),
      query,
    );
    expect(ctx.views.publish).toHaveBeenCalledWith(ctx.stored);
  });

  it('fails the read and publishes nothing when the view cannot be stored', async () => {
    const ctx = setup();
    ctx.views.recordPlatformView.mockRejectedValue(new Error('db down'));

    await expect(
      ctx.service.listPlatform(actorId, platformQuery()),
    ).rejects.toThrow('db down');
    expect(ctx.views.publish).not.toHaveBeenCalled();
  });
});

describe('AuditLogsService.listOrganization', () => {
  it('rejects inactive actors', async () => {
    const ctx = setup();
    ctx.permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      ctx.service.listOrganization(
        actorId,
        organizationId,
        organizationQuery(),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(ctx.access.assertCanRead).not.toHaveBeenCalled();
  });

  it('does not use platform permissions', async () => {
    const ctx = setup();

    await ctx.service.listOrganization(
      actorId,
      organizationId,
      organizationQuery(),
    );

    expect(ctx.permissions.hasPlatformPermission).not.toHaveBeenCalled();
    expect(ctx.access.assertCanRead).toHaveBeenCalledWith(
      ctx.manager,
      actorId,
      organizationId,
    );
  });

  it('stops before reading when access is denied', async () => {
    const ctx = setup();
    ctx.access.assertCanRead.mockRejectedValue(
      Object.assign(new Error('denied'), { status: 403 }),
    );

    await expect(
      ctx.service.listOrganization(
        actorId,
        organizationId,
        organizationQuery(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(ctx.reader.readPage).not.toHaveBeenCalled();
    expect(ctx.views.publish).not.toHaveBeenCalled();
  });

  it('scopes the read to the route organization and records the view', async () => {
    const ctx = setup();
    const query = organizationQuery();

    await expect(
      ctx.service.listOrganization(actorId, organizationId, query),
    ).resolves.toBe(ctx.page);

    expect(ctx.reader.readPage).toHaveBeenCalledWith(
      ctx.manager,
      query,
      organizationId,
    );
    expect(ctx.views.recordOrganizationView).toHaveBeenCalledWith(
      ctx.manager,
      actorId,
      organizationId,
      expect.any(String),
      query,
    );
    expect(ctx.views.publish).toHaveBeenCalledWith(ctx.stored);
  });

  it('rejects invalid pagination with 422', async () => {
    const ctx = setup();

    await expect(
      ctx.service.listOrganization(
        actorId,
        organizationId,
        organizationQuery({ limit: 0 }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});
