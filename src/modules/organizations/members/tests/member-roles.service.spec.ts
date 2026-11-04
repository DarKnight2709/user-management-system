import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { MemberRolesService } from '../member-roles.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const memberId = '123e4567-e89b-42d3-a456-426614174000';
const roleId = '423e4567-e89b-42d3-a456-426614174000';

function setup() {
  const member = {
    id: memberId,
    userId: '523e4567-e89b-42d3-a456-426614174000',
  };
  const role = {
    id: roleId,
    name: 'EDITOR',
    rolePermissions: [
      { permission: { resource: 'ORGANIZATION_MEMBER', action: 'read' } },
    ],
  };
  const manager = {
    organizationMember: { findFirst: vi.fn().mockResolvedValue(member) },
    role: { findFirst: vi.fn().mockResolvedValue(role) },
    organization: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ownerId: actorId }),
    },
    memberRole: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const prisma = {
    serializableTransaction: vi.fn(
      async (
        operation: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => operation(manager as unknown as Prisma.TransactionClient),
    ),
  };
  const service = new MemberRolesService(
    prisma as unknown as PrismaService,
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, role, prisma };
}

describe('MemberRolesService', () => {
  it('assigns a role and publishes its audit after commit', async () => {
    const { service, manager, logging } = setup();

    await service.assignForActor(actorId, organizationId, memberId, roleId);

    expect(manager.memberRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: { organizationMemberId: memberId, roleId },
      }),
    );
    expect(logging.audit).toHaveBeenCalledOnce();
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith({
      id: 'audit-id',
    });
  });

  it('does not audit an already assigned role', async () => {
    const { service, manager, logging } = setup();
    manager.memberRole.findUnique.mockResolvedValue({ deletedAt: null });

    await service.assignForActor(actorId, organizationId, memberId, roleId);

    expect(manager.memberRole.upsert).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
  });

  it('revokes an active role and records the revoke audit', async () => {
    const { service, manager, logging } = setup();

    await service.revokeForActor(actorId, organizationId, memberId, roleId);

    expect(manager.memberRole.updateMany).toHaveBeenCalledWith({
      where: { organizationMemberId: memberId, roleId, deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(logging.audit).toHaveBeenCalledOnce();
  });

  it('keeps repeated revoke idempotent', async () => {
    const { service, manager, logging } = setup();
    manager.memberRole.updateMany.mockResolvedValue({ count: 0 });

    await service.revokeForActor(actorId, organizationId, memberId, roleId);

    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('rejects inactive target members', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findFirst.mockResolvedValue(null);

    await expect(
      service.assignForActor(actorId, organizationId, memberId, roleId),
    ).rejects.toThrow('Active organization member not found');
  });

  it('rejects actors without the assign permission', async () => {
    const { service, permissions } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.assignForActor(actorId, organizationId, memberId, roleId),
    ).rejects.toThrow('Organization role assignment access denied');
  });

  it('rejects owner roles', async () => {
    const { service, manager } = setup();
    manager.role.findFirst.mockResolvedValue({
      id: roleId,
      name: 'OWNER',
      rolePermissions: [],
    });

    await expect(
      service.assignForActor(actorId, organizationId, memberId, roleId),
    ).rejects.toThrow('Ownership cannot be assigned or revoked as a role');
  });

  it('allows owners to delegate catalog permissions without a second permission lookup', async () => {
    const { service, permissions } = setup();

    await service.assignForActor(actorId, organizationId, memberId, roleId);

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledOnce();
  });

  it('rejects a role containing permissions outside the catalog', async () => {
    const { service, manager } = setup();
    manager.role.findFirst.mockResolvedValue({
      id: roleId,
      name: 'EDITOR',
      rolePermissions: [
        { permission: { resource: 'UNSUPPORTED', action: 'grant' } },
      ],
    });

    await expect(
      service.assignForActor(actorId, organizationId, memberId, roleId),
    ).rejects.toThrow('outside the organization catalog');
  });

  it('requires the actor to hold every delegated permission', async () => {
    const { service, manager, permissions } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    permissions.hasOrganizationPermissions
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      service.assignForActor(actorId, organizationId, memberId, roleId),
    ).rejects.toThrow('beyond your organization authority');
  });

  it('allows a non-owner to delegate a role without permissions', async () => {
    const { service, manager, permissions } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    manager.role.findFirst.mockResolvedValue({
      id: roleId,
      name: 'EMPTY',
      rolePermissions: [],
    });

    await service.assignForActor(actorId, organizationId, memberId, roleId);

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledOnce();
  });
});
