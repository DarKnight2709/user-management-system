import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { RoleAuthorityService } from '../role-authority.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const roleRead = {
  id: 'p-role-read',
  resource: 'ORGANIZATION_ROLE',
  action: 'read',
  description: null,
};
const auditRead = {
  id: 'p-audit-read',
  resource: 'ORGANIZATION_AUDIT_LOG',
  action: 'read',
  description: null,
};

function setup() {
  const manager = {
    organization: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ownerId: 'someone-else' }),
    },
    permission: { findMany: vi.fn().mockResolvedValue([roleRead]) },
    role: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  const service = new RoleAuthorityService(
    permissions as unknown as PermissionsService,
  );
  return {
    service,
    permissions,
    manager,
    client: manager as unknown as Prisma.TransactionClient,
  };
}

describe('RoleAuthorityService.authorize', () => {
  it('requires the requested ORGANIZATION_ROLE action', async () => {
    const { service, permissions, client } = setup();

    await service.authorize(client, actorId, organizationId, 'create');

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action: 'create' }],
      client,
    );
  });

  it('propagates an inactive actor rejection', async () => {
    const { service, permissions, client } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      service.authorize(client, actorId, organizationId, 'read'),
    ).rejects.toMatchObject({ status: 401 });
    expect(permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('rejects actors without the permission', async () => {
    const { service, permissions, client } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.authorize(client, actorId, organizationId, 'delete'),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('RoleAuthorityService.assertCanManageRole', () => {
  it('lets the owner manage any role without a permission lookup', async () => {
    const { service, manager, permissions, client } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: actorId,
    });

    await service.assertCanManageRole(client, actorId, organizationId, [
      auditRead,
    ]);

    expect(permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('lets a non-owner manage a role without grants', async () => {
    const { service, permissions, client } = setup();

    await service.assertCanManageRole(client, actorId, organizationId, []);

    expect(permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('lets a non-owner manage a role whose grants they hold', async () => {
    const { service, client } = setup();

    await expect(
      service.assertCanManageRole(client, actorId, organizationId, [roleRead]),
    ).resolves.toBeUndefined();
  });

  it('rejects a non-owner who lacks a current grant', async () => {
    const { service, permissions, client } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.assertCanManageRole(client, actorId, organizationId, [roleRead]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects a non-owner when the role holds a non-assignable grant', async () => {
    const { service, client } = setup();

    await expect(
      service.assertCanManageRole(client, actorId, organizationId, [auditRead]),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('RoleAuthorityService.loadGrantablePermissions', () => {
  it('returns the requested permissions when the actor holds them', async () => {
    const { service, client } = setup();

    await expect(
      service.loadGrantablePermissions(client, actorId, organizationId, [
        roleRead.id,
      ]),
    ).resolves.toEqual([roleRead]);
  });

  it('rejects an unknown or inactive permission ID', async () => {
    const { service, manager, client } = setup();
    manager.permission.findMany.mockResolvedValue([]);

    await expect(
      service.loadGrantablePermissions(client, actorId, organizationId, [
        'missing',
      ]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects the organization audit permission', async () => {
    const { service, manager, client } = setup();
    manager.permission.findMany.mockResolvedValue([auditRead]);

    await expect(
      service.loadGrantablePermissions(client, actorId, organizationId, [
        auditRead.id,
      ]),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects delegation beyond the actor authority', async () => {
    const { service, permissions, client } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.loadGrantablePermissions(client, actorId, organizationId, [
        roleRead.id,
      ]),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('allows an empty permission list without an authority lookup', async () => {
    const { service, manager, permissions, client } = setup();
    manager.permission.findMany.mockResolvedValue([]);

    await expect(
      service.loadGrantablePermissions(client, actorId, organizationId, []),
    ).resolves.toEqual([]);
    expect(permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });
});

describe('RoleAuthorityService.assertNameAvailable', () => {
  it('accepts an unused name', async () => {
    const { service, client } = setup();

    await expect(
      service.assertNameAvailable(client, organizationId, 'EDITOR'),
    ).resolves.toBeUndefined();
  });

  it('reserves names that already exist, including deleted roles', async () => {
    const { service, manager, client } = setup();
    manager.role.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.assertNameAvailable(client, organizationId, 'EDITOR'),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ deletedAt: expect.anything() }),
      }),
    );
  });

  it('excludes the role being renamed from the duplicate check', async () => {
    const { service, manager, client } = setup();

    await service.assertNameAvailable(client, organizationId, 'EDITOR', 'self');

    expect(manager.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { not: 'self' } }),
      }),
    );
  });
});
