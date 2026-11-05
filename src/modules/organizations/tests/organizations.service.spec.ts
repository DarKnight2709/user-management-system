import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { OrganizationsService } from '../organizations.service.js';
import type { UpdateOrganizationDto } from '../dto/update-organization.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';

const organization = (name = 'Acme') => ({
  id: organizationId,
  name,
  slug: 'acme',
  ownerId: actorId,
  isActive: true,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
});

function setup() {
  const manager = {
    organization: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findUniqueOrThrow: vi.fn().mockResolvedValue(organization()),
      update: vi.fn().mockResolvedValue(organization('Renamed')),
    },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
    findAuthorizedOrganizationIds: vi.fn().mockResolvedValue([organizationId]),
    getEffectiveOrganizationPermissions: vi.fn().mockResolvedValue([]),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new OrganizationsService(
    createPrismaStub(manager),
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, auditEvent };
}

const renameTo = (name: string) => ({ name }) as UpdateOrganizationDto;

describe('OrganizationsService.findAllForActor', () => {
  it('rejects inactive actors', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(service.findAllForActor({ actorId })).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.organization.findMany).not.toHaveBeenCalled();
  });

  it('uses page 1 and limit 20 by default', async () => {
    const { service, manager } = setup();

    await expect(service.findAllForActor({ actorId })).resolves.toMatchObject({
      page: 1,
      limit: 20,
    });
    expect(manager.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it.each([
    { page: 0 },
    { page: 1_000_001 },
    { limit: 0 },
    { limit: 101 },
    { page: 1.5 },
  ])('rejects invalid pagination %j', async (pagination) => {
    const { service, permissions } = setup();

    await expect(
      service.findAllForActor({ actorId, ...pagination }),
    ).rejects.toMatchObject({ status: 422 });
    expect(permissions.assertActiveActor).not.toHaveBeenCalled();
  });

  it('skips earlier pages', async () => {
    const { service, manager } = setup();

    await service.findAllForActor({ actorId, page: 3, limit: 10 });

    expect(manager.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('restricts the page to active organizations the actor may read', async () => {
    const { service, manager, permissions } = setup();

    await service.findAllForActor({ actorId });

    expect(permissions.findAuthorizedOrganizationIds).toHaveBeenCalledWith(
      actorId,
      [{ resource: 'ORGANIZATION', action: 'read' }],
      expect.anything(),
    );
    expect(manager.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: [organizationId] },
          deletedAt: null,
          isActive: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    );
  });

  it('returns an empty page without a platform bypass when nothing is authorized', async () => {
    const { service, manager, permissions } = setup();
    permissions.findAuthorizedOrganizationIds.mockResolvedValue([]);

    await expect(service.findAllForActor({ actorId })).resolves.toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
    });
    expect(manager.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: [] } }),
      }),
    );
  });

  it('returns the page, total and paging values', async () => {
    const { service, manager } = setup();
    manager.organization.findMany.mockResolvedValue([organization()]);
    manager.organization.count.mockResolvedValue(41);

    await expect(
      service.findAllForActor({ actorId, page: 2, limit: 1 }),
    ).resolves.toEqual({
      items: [organization()],
      total: 41,
      page: 2,
      limit: 1,
    });
  });
});

describe('OrganizationsService.findOneForActor', () => {
  it('requires ORGANIZATION read access', async () => {
    const { service, permissions } = setup();

    await service.findOneForActor(actorId, organizationId);

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION', action: 'read' }],
      expect.anything(),
    );
  });

  it('denies inaccessible organizations before reading them', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.findOneForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organization.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects inactive actors', async () => {
    const { service, permissions } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      service.findOneForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('only returns active undeleted organizations', async () => {
    const { service, manager } = setup();

    await expect(
      service.findOneForActor(actorId, organizationId),
    ).resolves.toEqual(organization());
    expect(manager.organization.findUniqueOrThrow).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: organizationId, deletedAt: null, isActive: true },
      }),
    );
  });

  it('never selects member or role data', async () => {
    const { service, manager } = setup();

    await service.findOneForActor(actorId, organizationId);

    const { select } = manager.organization.findUniqueOrThrow.mock
      .calls[0][0] as { select: Record<string, unknown> };
    expect(Object.keys(select).sort()).toEqual([
      'createdAt',
      'id',
      'isActive',
      'name',
      'ownerId',
      'slug',
      'updatedAt',
    ]);
  });
});

describe('OrganizationsService.updateForActor', () => {
  it('requires ORGANIZATION update access', async () => {
    const { service, permissions } = setup();

    await service.updateForActor(actorId, organizationId, renameTo('Renamed'));

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION', action: 'update' }],
      expect.anything(),
    );
  });

  it('denies callers without update access and writes nothing', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.updateForActor(actorId, organizationId, renameTo('Renamed')),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organization.update).not.toHaveBeenCalled();
  });

  it('writes only the name, ignoring protected fields', async () => {
    const { service, manager } = setup();
    const dto = {
      name: 'Renamed',
      ownerId: 'attacker',
      slug: 'hijacked',
    } as unknown as UpdateOrganizationDto;

    await service.updateForActor(actorId, organizationId, dto);

    expect(manager.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: 'Renamed' } }),
    );
  });

  it('audits the change and publishes after commit', async () => {
    const { service, logging, auditEvent } = setup();

    await expect(
      service.updateForActor(actorId, organizationId, renameTo('Renamed')),
    ).resolves.toEqual(organization('Renamed'));

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.updated',
        payload: { before: { name: 'Acme' }, after: { name: 'Renamed' } },
      }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('treats an unchanged name as a no-op without audit', async () => {
    const { service, manager, logging } = setup();

    await expect(
      service.updateForActor(actorId, organizationId, renameTo('Acme')),
    ).resolves.toEqual(organization());

    expect(manager.organization.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('does not publish an audit event when the update fails', async () => {
    const { service, manager, logging } = setup();
    manager.organization.update.mockRejectedValue(new Error('write failed'));

    await expect(
      service.updateForActor(actorId, organizationId, renameTo('Renamed')),
    ).rejects.toThrow('write failed');
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});

describe('OrganizationsService.currentPermissions', () => {
  it('delegates to the effective permission lookup in a transaction', async () => {
    const { service, permissions } = setup();
    const effective = [{ id: 'p1', resource: 'ORGANIZATION', action: 'read' }];
    permissions.getEffectiveOrganizationPermissions.mockResolvedValue(
      effective,
    );

    await expect(
      service.currentPermissions(actorId, organizationId),
    ).resolves.toBe(effective);
    expect(
      permissions.getEffectiveOrganizationPermissions,
    ).toHaveBeenCalledWith(actorId, organizationId, expect.anything());
  });

  it('propagates access denials', async () => {
    const { service, permissions } = setup();
    permissions.getEffectiveOrganizationPermissions.mockRejectedValue(
      Object.assign(new Error('denied'), { status: 403 }),
    );

    await expect(
      service.currentPermissions(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
  });
});
