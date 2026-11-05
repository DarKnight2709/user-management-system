import { describe, expect, it, vi } from 'vitest';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../../test/support/prisma-stub.js';
import { RoleAuthorityService } from '../role-authority.service.js';
import { OrganizationRoleManagementService } from '../organization-role-management.service.js';
import type { CreateOrganizationRoleDto } from '../dto/create-organization-role.dto.js';
import type { UpdateOrganizationRoleDto } from '../dto/update-organization-role.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const roleId = '423e4567-e89b-42d3-a456-426614174000';
const permissionId = '623e4567-e89b-42d3-a456-426614174000';
const otherPermissionId = '723e4567-e89b-42d3-a456-426614174000';
const target = { actorId, organizationId, roleId };

const permission = (id: string, action: string) => ({
  id,
  resource: 'ORGANIZATION_MEMBER',
  action,
  description: null,
});
const readPermission = permission(permissionId, 'read');
const invitePermission = permission(otherPermissionId, 'invite');

const storedRole = (overrides: Record<string, unknown> = {}) => ({
  id: roleId,
  name: 'EDITOR',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-02'),
  deletedAt: null,
  rolePermissions: [{ permission: readPermission }],
  ...overrides,
});

function setup() {
  const manager = {
    role: {
      create: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(storedRole()),
      update: vi.fn(),
    },
    rolePermission: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
  manager.role.create.mockResolvedValue({
    id: roleId,
    name: 'REVIEWER',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  });
  manager.role.update.mockImplementation(
    ({ data }: { data: { name?: string } }) =>
      Promise.resolve({
        id: roleId,
        name: data.name ?? 'EDITOR',
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-02-01'),
      }),
  );
  const authority = {
    authorize: vi.fn().mockResolvedValue(undefined),
    assertCanManageRole: vi.fn().mockResolvedValue(undefined),
    assertNameAvailable: vi.fn().mockResolvedValue(undefined),
    loadGrantablePermissions: vi.fn().mockResolvedValue([readPermission]),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new OrganizationRoleManagementService(
    createPrismaStub(manager),
    authority as unknown as RoleAuthorityService,
    logging as unknown as LoggingService,
  );
  return { service, manager, authority, logging, auditEvent };
}

const createDto = (overrides: Partial<CreateOrganizationRoleDto> = {}) =>
  ({
    name: 'reviewer',
    permissionIds: [permissionId],
    ...overrides,
  }) as CreateOrganizationRoleDto;

const updateDto = (dto: Partial<UpdateOrganizationRoleDto>) =>
  dto as UpdateOrganizationRoleDto;

describe('OrganizationRoleManagementService.createForActor', () => {
  it('creates a non-system role with the requested grants', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, organizationId, createDto());

    expect(manager.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          organizationId,
          name: 'REVIEWER',
          isSystem: false,
          rolePermissions: { create: [{ permissionId }] },
        },
      }),
    );
  });

  it('returns the role with its permissions and a custom label', async () => {
    const { service } = setup();

    await expect(
      service.createForActor(actorId, organizationId, createDto()),
    ).resolves.toMatchObject({
      id: roleId,
      isBuiltIn: false,
      permissions: [readPermission],
    });
  });

  it('allows a role without permissions', async () => {
    const { service, authority, manager } = setup();
    authority.loadGrantablePermissions.mockResolvedValue([]);

    await service.createForActor(
      actorId,
      organizationId,
      createDto({ permissionIds: [] }),
    );

    expect(manager.role.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rolePermissions: { create: [] } }),
      }),
    );
  });

  it('authorizes role creation before reading permissions', async () => {
    const { service, authority } = setup();
    authority.authorize.mockRejectedValue(new Error('denied'));

    await expect(
      service.createForActor(actorId, organizationId, createDto()),
    ).rejects.toThrow('denied');
    expect(authority.loadGrantablePermissions).not.toHaveBeenCalled();
    expect(authority.authorize).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      'create',
    );
  });

  it('does not create a role when the name is taken', async () => {
    const { service, authority, manager } = setup();
    authority.assertNameAvailable.mockRejectedValue(new Error('taken'));

    await expect(
      service.createForActor(actorId, organizationId, createDto()),
    ).rejects.toThrow('taken');
    expect(manager.role.create).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'admin', ' Member '])(
    'rejects the reserved name %j',
    async (name) => {
      const { service, manager } = setup();

      await expect(
        service.createForActor(actorId, organizationId, createDto({ name })),
      ).rejects.toMatchObject({ status: 422 });
      expect(manager.role.create).not.toHaveBeenCalled();
    },
  );

  it.each(['', '1ABC', 'HAS SPACE', 'A'.repeat(51)])(
    'rejects the invalid name %j',
    async (name) => {
      const { service } = setup();

      await expect(
        service.createForActor(actorId, organizationId, createDto({ name })),
      ).rejects.toMatchObject({ status: 422 });
    },
  );

  it('accepts a 50 character name', async () => {
    const { service } = setup();

    await expect(
      service.createForActor(
        actorId,
        organizationId,
        createDto({ name: 'a'.repeat(50) }),
      ),
    ).resolves.toBeDefined();
  });

  it('rejects duplicate or malformed permission IDs', async () => {
    const { service } = setup();

    await expect(
      service.createForActor(
        actorId,
        organizationId,
        createDto({ permissionIds: [permissionId, permissionId] }),
      ),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      service.createForActor(
        actorId,
        organizationId,
        createDto({ permissionIds: ['not-a-uuid'] }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('records the audit event and publishes it after the transaction', async () => {
    const { service, logging, auditEvent } = setup();

    await service.createForActor(actorId, organizationId, createDto());

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.role.created',
        organizationId,
        target: { type: 'ROLE', id: roleId },
      }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('does not publish an audit event when the transaction fails', async () => {
    const { service, authority, logging } = setup();
    authority.loadGrantablePermissions.mockRejectedValue(new Error('beyond'));

    await expect(
      service.createForActor(actorId, organizationId, createDto()),
    ).rejects.toThrow('beyond');
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});

describe('OrganizationRoleManagementService.updateForActor', () => {
  it.each([{}, { name: undefined, permissionIds: undefined }])(
    'rejects an empty update %j',
    async (dto) => {
      const { service, authority } = setup();

      await expect(
        service.updateForActor(target, updateDto(dto)),
      ).rejects.toMatchObject({ status: 422 });
      expect(authority.authorize).not.toHaveBeenCalled();
    },
  );

  it('rejects null fields', async () => {
    const { service } = setup();

    await expect(
      service.updateForActor(
        target,
        updateDto({ name: null as unknown as string }),
      ),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects reserved names', async () => {
    const { service } = setup();

    await expect(
      service.updateForActor(target, updateDto({ name: 'admin' })),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('authorizes the update action', async () => {
    const { service, authority } = setup();

    await service.updateForActor(target, updateDto({ name: 'editors' }));

    expect(authority.authorize).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      'update',
    );
  });

  it('renames a role and keeps its grants untouched', async () => {
    const { service, manager, authority } = setup();

    const result = await service.updateForActor(
      target,
      updateDto({ name: 'editors' }),
    );

    expect(authority.assertNameAvailable).toHaveBeenCalledWith(
      expect.anything(),
      organizationId,
      'EDITORS',
      roleId,
    );
    expect(manager.rolePermission.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      name: 'EDITORS',
      isBuiltIn: false,
      permissions: [readPermission],
    });
  });

  it('replaces grants, soft-revoking removed ones and restoring requested ones', async () => {
    const { service, manager, authority } = setup();
    authority.loadGrantablePermissions.mockResolvedValue([invitePermission]);

    const result = await service.updateForActor(
      target,
      updateDto({ permissionIds: [otherPermissionId] }),
    );

    expect(manager.rolePermission.updateMany).toHaveBeenCalledWith({
      where: {
        roleId,
        deletedAt: null,
        permissionId: { notIn: [otherPermissionId] },
      },
      data: { deletedAt: expect.any(Date) },
    });
    expect(manager.rolePermission.upsert).toHaveBeenCalledWith({
      where: {
        roleId_permissionId: { roleId, permissionId: otherPermissionId },
      },
      create: { roleId, permissionId: otherPermissionId },
      update: { deletedAt: null },
    });
    expect(result).toMatchObject({ permissions: [invitePermission] });
  });

  it('clears every grant when given an empty list', async () => {
    const { service, manager, authority } = setup();
    authority.loadGrantablePermissions.mockResolvedValue([]);

    await service.updateForActor(target, updateDto({ permissionIds: [] }));

    expect(manager.rolePermission.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ permissionId: { notIn: [] } }),
      }),
    );
    expect(manager.rolePermission.upsert).not.toHaveBeenCalled();
  });

  it('is a no-op without audit when nothing changes', async () => {
    const { service, manager, logging } = setup();

    const result = await service.updateForActor(
      target,
      updateDto({ name: 'editor', permissionIds: [permissionId] }),
    );

    expect(manager.role.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      name: 'EDITOR',
      permissions: [readPermission],
    });
  });

  it('still checks authority over requested permissions on a no-op', async () => {
    const { service, authority } = setup();

    await service.updateForActor(
      target,
      updateDto({ permissionIds: [permissionId] }),
    );

    expect(authority.loadGrantablePermissions).toHaveBeenCalled();
  });

  it('checks authority over the current grants before changing anything', async () => {
    const { service, authority, manager } = setup();
    authority.assertCanManageRole.mockRejectedValue(new Error('beyond'));

    await expect(
      service.updateForActor(target, updateDto({ name: 'editors' })),
    ).rejects.toThrow('beyond');
    expect(manager.role.update).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN', 'MEMBER'])(
    'refuses to modify the built-in %s role',
    async (name) => {
      const { service, manager } = setup();
      manager.role.findFirst.mockResolvedValue(storedRole({ name }));

      await expect(
        service.updateForActor(target, updateDto({ name: 'editors' })),
      ).rejects.toMatchObject({ status: 403 });
    },
  );

  it('returns 404 for a missing or deleted role', async () => {
    const { service, manager } = setup();
    manager.role.findFirst.mockResolvedValue(null);

    await expect(
      service.updateForActor(target, updateDto({ name: 'editors' })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('scopes the role lookup to the organization and non-system roles', async () => {
    const { service, manager } = setup();

    await service.updateForActor(target, updateDto({ name: 'editors' }));

    expect(manager.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: roleId,
          organizationId,
          isSystem: false,
          deletedAt: null,
        },
      }),
    );
  });

  it('audits before and after states and publishes after commit', async () => {
    const { service, logging, auditEvent } = setup();

    await service.updateForActor(target, updateDto({ name: 'editors' }));

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.role.updated',
        payload: {
          before: {
            name: 'EDITOR',
            permissions: [
              {
                id: permissionId,
                resource: 'ORGANIZATION_MEMBER',
                action: 'read',
              },
            ],
          },
          after: {
            name: 'EDITORS',
            permissions: [
              {
                id: permissionId,
                resource: 'ORGANIZATION_MEMBER',
                action: 'read',
              },
            ],
          },
        },
      }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });
});

describe('OrganizationRoleManagementService.deleteForActor', () => {
  it('authorizes the delete action and the current grants', async () => {
    const { service, authority } = setup();

    await service.deleteForActor(target);

    expect(authority.authorize).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      'delete',
    );
    expect(authority.assertCanManageRole).toHaveBeenCalledWith(
      expect.anything(),
      actorId,
      organizationId,
      [readPermission],
    );
  });

  it('soft-deletes only the role', async () => {
    const { service, manager } = setup();

    await service.deleteForActor(target);

    expect(manager.role.update).toHaveBeenCalledWith({
      where: { id: roleId, organizationId },
      data: { deletedAt: expect.any(Date) },
    });
    expect(manager.rolePermission.updateMany).not.toHaveBeenCalled();
  });

  it('audits the deletion and publishes after commit', async () => {
    const { service, logging, auditEvent } = setup();

    await service.deleteForActor(target);

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'organization.role.deleted' }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('is idempotent for an already deleted role', async () => {
    const { service, manager, logging } = setup();
    manager.role.findFirst.mockResolvedValue(
      storedRole({ deletedAt: new Date('2026-03-01') }),
    );

    await expect(service.deleteForActor(target)).resolves.toBeUndefined();

    expect(manager.role.update).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('still rechecks authority for an already deleted role', async () => {
    const { service, manager, authority } = setup();
    manager.role.findFirst.mockResolvedValue(
      storedRole({ deletedAt: new Date('2026-03-01') }),
    );
    authority.assertCanManageRole.mockRejectedValue(new Error('beyond'));

    await expect(service.deleteForActor(target)).rejects.toThrow('beyond');
  });

  it('includes deleted roles when looking up the target', async () => {
    const { service, manager } = setup();

    await service.deleteForActor(target);

    expect(manager.role.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ deletedAt: null }),
      }),
    );
  });

  it.each(['OWNER', 'ADMIN', 'MEMBER'])(
    'refuses to delete the built-in %s role',
    async (name) => {
      const { service, manager } = setup();
      manager.role.findFirst.mockResolvedValue(storedRole({ name }));

      await expect(service.deleteForActor(target)).rejects.toMatchObject({
        status: 403,
      });
      expect(manager.role.update).not.toHaveBeenCalled();
    },
  );

  it('returns 404 when the role does not exist in the organization', async () => {
    const { service, manager } = setup();
    manager.role.findFirst.mockResolvedValue(null);

    await expect(service.deleteForActor(target)).rejects.toMatchObject({
      status: 404,
    });
  });
});
