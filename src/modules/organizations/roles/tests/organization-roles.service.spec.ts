import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { createPrismaStub } from '../../../../../test/support/prisma-stub.js';
import { RoleAuthorityService } from '../role-authority.service.js';
import { OrganizationRolesService } from '../organization-roles.service.js';
import type { ListOrganizationRolesQueryDto } from '../dto/list-organization-roles-query.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const permissionId = '623e4567-e89b-42d3-a456-426614174000';

const query = (
  overrides: Partial<ListOrganizationRolesQueryDto> = {},
): ListOrganizationRolesQueryDto =>
  ({ page: 1, limit: 20, ...overrides }) as ListOrganizationRolesQueryDto;

function setup() {
  const manager = {
    role: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    permission: { findMany: vi.fn().mockResolvedValue([]) },
  };
  const authority = { authorize: vi.fn().mockResolvedValue(undefined) };
  const permissions = {
    getEffectiveOrganizationPermissions: vi.fn().mockResolvedValue([]),
  };
  const service = new OrganizationRolesService(
    createPrismaStub(manager),
    permissions as unknown as PermissionsService,
    authority as unknown as RoleAuthorityService,
  );
  return { service, manager, authority, permissions };
}

const lastRoleFilter = (manager: ReturnType<typeof setup>['manager']) =>
  (manager.role.findMany.mock.calls[0][0] as { where: Record<string, unknown> })
    .where;

describe('OrganizationRolesService.listForActor', () => {
  it('requires ORGANIZATION_ROLE read access', async () => {
    const { service, authority } = setup();

    await service.listForActor(actorId, organizationId, query());

    expect(authority.authorize).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      'read',
    );
  });

  it('does not query roles when authorization fails', async () => {
    const { service, manager, authority } = setup();
    authority.authorize.mockRejectedValue(new Error('denied'));

    await expect(
      service.listForActor(actorId, organizationId, query()),
    ).rejects.toThrow('denied');
    expect(manager.role.findMany).not.toHaveBeenCalled();
  });

  it.each([
    { page: 0, limit: 20 },
    { page: 1_000_001, limit: 20 },
    { page: 1, limit: 0 },
    { page: 1, limit: 101 },
    { page: 1.5, limit: 20 },
  ])(
    'rejects invalid pagination %j before opening a transaction',
    async (pagination) => {
      const { service, authority } = setup();

      await expect(
        service.listForActor(actorId, organizationId, query(pagination)),
      ).rejects.toMatchObject({ status: 422 });
      expect(authority.authorize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { page: 1, limit: 1 },
    { page: 1_000_000, limit: 100 },
  ])('accepts boundary pagination %j', async (pagination) => {
    const { service } = setup();

    await expect(
      service.listForActor(actorId, organizationId, query(pagination)),
    ).resolves.toMatchObject(pagination);
  });

  it('skips earlier pages', async () => {
    const { service, manager } = setup();

    await service.listForActor(
      actorId,
      organizationId,
      query({ page: 3, limit: 10 }),
    );

    expect(manager.role.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });

  it('scopes roles to the organization and hides OWNER, system and deleted roles', async () => {
    const { service, manager } = setup();

    await service.listForActor(actorId, organizationId, query());

    expect(lastRoleFilter(manager)).toMatchObject({
      organizationId,
      isSystem: false,
      deletedAt: null,
      name: { not: 'OWNER' },
    });
  });

  it('filters built-in roles', async () => {
    const { service, manager } = setup();

    await service.listForActor(
      actorId,
      organizationId,
      query({ type: 'BUILT_IN' }),
    );

    expect(lastRoleFilter(manager)).toMatchObject({
      name: { not: 'OWNER', in: ['ADMIN', 'MEMBER'] },
    });
  });

  it('filters custom roles', async () => {
    const { service, manager } = setup();

    await service.listForActor(
      actorId,
      organizationId,
      query({ type: 'CUSTOM' }),
    );

    expect(lastRoleFilter(manager)).toMatchObject({
      name: { notIn: ['OWNER', 'ADMIN', 'MEMBER'] },
    });
  });

  it('searches names case-insensitively', async () => {
    const { service, manager } = setup();

    await service.listForActor(
      actorId,
      organizationId,
      query({ search: 'edit' }),
    );

    expect(lastRoleFilter(manager)).toMatchObject({
      name: { contains: 'edit', mode: 'insensitive' },
    });
  });

  it('filters by an active catalog permission grant', async () => {
    const { service, manager } = setup();

    await service.listForActor(
      actorId,
      organizationId,
      query({ permissionId }),
    );

    expect(lastRoleFilter(manager)).toMatchObject({
      rolePermissions: {
        some: { permissionId, deletedAt: null },
      },
    });
  });

  it('labels built-in roles and flattens permissions', async () => {
    const { service, manager } = setup();
    const permission = {
      id: permissionId,
      resource: 'ORGANIZATION',
      action: 'read',
      description: null,
    };
    manager.role.findMany.mockResolvedValue([
      {
        id: 'r1',
        name: 'ADMIN',
        rolePermissions: [{ permission }],
      },
      { id: 'r2', name: 'EDITOR', rolePermissions: [] },
    ]);
    manager.role.count.mockResolvedValue(2);

    const result = await service.listForActor(actorId, organizationId, query());

    expect(result).toEqual({
      items: [
        { id: 'r1', name: 'ADMIN', isBuiltIn: true, permissions: [permission] },
        { id: 'r2', name: 'EDITOR', isBuiltIn: false, permissions: [] },
      ],
      total: 2,
      page: 1,
      limit: 20,
    });
  });
});

describe('OrganizationRolesService.catalogForActor', () => {
  it('requires ORGANIZATION_ROLE read access', async () => {
    const { service, authority } = setup();

    await service.catalogForActor(actorId, organizationId);

    expect(authority.authorize).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      'read',
    );
  });

  it('only offers permissions the actor effectively holds', async () => {
    const { service, manager, permissions } = setup();
    permissions.getEffectiveOrganizationPermissions.mockResolvedValue([
      { id: 'held', resource: 'ORGANIZATION_ROLE', action: 'read' },
    ]);

    await service.catalogForActor(actorId, organizationId);

    expect(manager.permission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['held'] } }),
      }),
    );
  });

  it('never offers the organization audit permission, even to owners', async () => {
    const { service, manager, permissions } = setup();
    permissions.getEffectiveOrganizationPermissions.mockResolvedValue([
      { id: 'audit', resource: 'ORGANIZATION_AUDIT_LOG', action: 'read' },
      { id: 'held', resource: 'ORGANIZATION', action: 'read' },
    ]);

    await service.catalogForActor(actorId, organizationId);

    expect(manager.permission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { in: ['held'] } }),
      }),
    );
  });

  it('returns the stored catalog rows', async () => {
    const { service, manager } = setup();
    const rows = [{ id: 'held', resource: 'ORGANIZATION', action: 'read' }];
    manager.permission.findMany.mockResolvedValue(rows);

    await expect(
      service.catalogForActor(actorId, organizationId),
    ).resolves.toBe(rows);
  });
});
