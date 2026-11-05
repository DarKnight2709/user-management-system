import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { OrganizationCreationService } from '../organization-creation.service.js';
import type { CreateOrganizationDto } from '../dto/create-organization.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const dto = { name: 'Acme', slug: 'acme' } as CreateOrganizationDto;

const defaultCatalog = [
  ['ORGANIZATION', 'read'],
  ['ORGANIZATION', 'update'],
  ['ORGANIZATION_MEMBER', 'read'],
  ['ORGANIZATION_MEMBER', 'invite'],
  ['ORGANIZATION_MEMBER', 'remove'],
  ['ORGANIZATION_ROLE', 'read'],
  ['ORGANIZATION_AUDIT_LOG', 'read'],
].map(([resource, action]) => ({
  id: `${resource}:${action}`,
  resource,
  action,
}));

function setup() {
  const manager = {
    organization: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: organizationId,
        name: dto.name,
        slug: dto.slug,
        ownerId: actorId,
      }),
    },
    permission: { findMany: vi.fn().mockResolvedValue(defaultCatalog) },
    organizationMember: { create: vi.fn().mockResolvedValue({}) },
    role: { create: vi.fn().mockResolvedValue({}) },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new OrganizationCreationService(
    createPrismaStub(manager),
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, auditEvent };
}

interface CreatedRoleArgs {
  data: {
    name: string;
    rolePermissions: { create: { permissionId: string }[] };
  };
}

const grantedKeysOf = (
  manager: ReturnType<typeof setup>['manager'],
  roleName: string,
) => {
  const createdRoles = manager.role.create.mock.calls.map(
    ([args]) => args as CreatedRoleArgs,
  );
  const role = createdRoles.find(({ data }) => data.name === roleName);
  if (!role) throw new Error(`Role ${roleName} was not created`);
  return role.data.rolePermissions.create
    .map(({ permissionId }) => permissionId)
    .sort();
};

describe('OrganizationCreationService.createForActor', () => {
  it('makes the caller the owner with an active membership', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    expect(manager.organization.create).toHaveBeenCalledWith({
      data: { name: 'Acme', slug: 'acme', ownerId: actorId },
    });
    expect(manager.organizationMember.create).toHaveBeenCalledWith({
      data: { organizationId, userId: actorId, status: 'ACTIVE' },
    });
  });

  it('does not create an OWNER role', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    const roleNames = manager.role.create.mock.calls.map(
      ([args]) => (args as { data: { name: string } }).data.name,
    );
    expect(roleNames).toEqual(['ADMIN', 'MEMBER']);
  });

  it('creates scoped, non-system ADMIN and MEMBER roles', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    for (const [args] of manager.role.create.mock.calls) {
      expect(args).toMatchObject({
        data: { organizationId, isSystem: false },
      });
    }
  });

  it('grants ADMIN every default permission including audit read', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    expect(grantedKeysOf(manager, 'ADMIN')).toEqual(
      defaultCatalog.map(({ id }) => id).sort(),
    );
  });

  it('grants MEMBER read permissions only, without audit read', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    expect(grantedKeysOf(manager, 'MEMBER')).toEqual([
      'ORGANIZATION:read',
      'ORGANIZATION_MEMBER:read',
      'ORGANIZATION_ROLE:read',
    ]);
  });

  it('rejects inactive actors before touching the database', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(service.createForActor(actorId, dto)).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.organization.create).not.toHaveBeenCalled();
  });

  it('rejects a taken slug, including one held by a deleted organization', async () => {
    const { service, manager } = setup();
    manager.organization.findUnique.mockResolvedValue({ id: 'existing' });

    await expect(service.createForActor(actorId, dto)).rejects.toMatchObject({
      status: 409,
    });
    expect(manager.organization.findUnique).toHaveBeenCalledWith({
      where: { slug: 'acme' },
      select: { id: true },
    });
    expect(manager.organization.create).not.toHaveBeenCalled();
  });

  it.each([0, 6])(
    'fails with 503 when only %i of 7 default permissions are active',
    async (available) => {
      const { service, manager } = setup();
      manager.permission.findMany.mockResolvedValue(
        defaultCatalog.slice(0, available),
      );

      await expect(service.createForActor(actorId, dto)).rejects.toMatchObject({
        status: 503,
      });
      expect(manager.organization.create).not.toHaveBeenCalled();
    },
  );

  it('only reads non-deleted permissions', async () => {
    const { service, manager } = setup();

    await service.createForActor(actorId, dto);

    expect(manager.permission.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deletedAt: null }),
      }),
    );
  });

  it('returns the created organization', async () => {
    const { service } = setup();

    await expect(service.createForActor(actorId, dto)).resolves.toMatchObject({
      id: organizationId,
      ownerId: actorId,
    });
  });

  it('audits creation and publishes after commit', async () => {
    const { service, logging, auditEvent } = setup();

    await service.createForActor(actorId, dto);

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.created',
        organizationId,
        payload: { name: 'Acme', slug: 'acme', ownerId: actorId },
      }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('does not publish audit when role provisioning fails', async () => {
    const { service, manager, logging } = setup();
    manager.role.create.mockRejectedValue(new Error('role failed'));

    await expect(service.createForActor(actorId, dto)).rejects.toThrow(
      'role failed',
    );
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});
