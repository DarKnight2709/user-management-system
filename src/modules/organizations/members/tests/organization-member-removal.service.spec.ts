import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { OrganizationMemberRemovalService } from '../organization-member-removal.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const memberId = '123e4567-e89b-42d3-a456-426614174000';

function setup() {
  const member = {
    id: memberId,
    userId: '523e4567-e89b-42d3-a456-426614174000',
    deletedAt: null,
    status: 'ACTIVE' as const,
  };
  const manager = {
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        ownerId: actorId,
        deletedAt: null,
        isActive: true,
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ ownerId: actorId }),
    },
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue({
        ...member,
        organization: { ownerId: actorId, deletedAt: null, isActive: true },
      } as unknown),
      findFirst: vi.fn(({ where }: { where?: { userId?: string } }): unknown =>
        where?.userId === actorId
          ? {
              id: 'actor-membership-id',
              userId: actorId,
              memberRoles: [{ role: { name: 'ADMIN' } }],
            }
          : { ...member, memberRoles: [] },
      ),
      update: vi.fn().mockResolvedValue(member),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
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
  const service = new OrganizationMemberRemovalService(
    prisma as unknown as PrismaService,
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, prisma };
}

describe('OrganizationMemberRemovalService', () => {
  it('leaves an active membership and publishes its audit', async () => {
    const { service, manager, logging } = setup();
    manager.organizationMember.findUnique.mockResolvedValue({
      id: memberId,
      userId: actorId,
      status: 'ACTIVE',
      deletedAt: null,
      organization: {
        ownerId: 'different-owner',
        deletedAt: null,
        isActive: true,
      },
    });

    await service.leaveForActor(actorId, organizationId);

    expect(manager.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: memberId, organizationId, userId: actorId },
      }),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith({
      id: 'audit-id',
    });
  });

  it('rejects an owner leaving the organization', async () => {
    const { service } = setup();

    await expect(
      service.leaveForActor(actorId, organizationId),
    ).rejects.toThrow('Transfer ownership before leaving');
  });

  it('rejects leaving when membership is not active', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findUnique.mockResolvedValue({
      id: memberId,
      userId: actorId,
      status: 'SUSPENDED',
      deletedAt: null,
      organization: {
        ownerId: 'different-owner',
        deletedAt: null,
        isActive: true,
      },
    });

    await expect(
      service.leaveForActor(actorId, organizationId),
    ).rejects.toThrow('Active membership required');
  });

  it('removes a member and writes an audit event', async () => {
    const { service, manager, logging } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });

    await service.removeForActor(actorId, organizationId, memberId);

    expect(manager.organizationMember.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: memberId, organizationId },
      }),
    );
    expect(logging.audit).toHaveBeenCalledOnce();
  });

  it('returns successfully without auditing an already removed member', async () => {
    const { service, manager, logging } = setup();
    manager.organizationMember.findFirst.mockImplementation(
      ({ where }: { where?: { userId?: string } }) =>
        where?.userId === actorId
          ? {
              id: 'actor-membership-id',
              userId: actorId,
              memberRoles: [{ role: { name: 'ADMIN' } }],
            }
          : {
              id: memberId,
              userId: 'other-user',
              deletedAt: new Date(),
              memberRoles: [],
            },
    );
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });

    await service.removeForActor(actorId, organizationId, memberId);

    expect(manager.organizationMember.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
  });

  it('rejects removing the organization owner', async () => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'owner-id',
    });
    manager.organizationMember.findFirst.mockResolvedValue({
      id: memberId,
      userId: 'owner-id',
      deletedAt: null,
      memberRoles: [],
    });

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('Transfer ownership before removing the owner');
  });

  it('forbids removal without the ORGANIZATION_MEMBER remove permission', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toMatchObject({ status: 403 });
    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_MEMBER', action: 'remove' }],
      manager,
    );
    expect(manager.organizationMember.update).not.toHaveBeenCalled();
  });

  it('returns 404 for a member outside the organization', async () => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    manager.organizationMember.findFirst.mockResolvedValue(null);

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toMatchObject({ status: 404 });
    expect(manager.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: memberId, organizationId } }),
    );
  });

  it.each([
    ['a peer ADMIN', 'ADMIN', 'ADMIN'],
    ['a higher-level ADMIN as a custom role', 'AUDITOR', 'ADMIN'],
    ['a peer custom role', 'AUDITOR', 'EDITOR'],
    ['a peer MEMBER', 'MEMBER', 'MEMBER'],
  ])('forbids a non-owner removing %s', async (_, actorRole, targetRole) => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    manager.organizationMember.findFirst.mockImplementation(
      ({ where }: { where?: { userId?: string } }) =>
        where?.userId === actorId
          ? { memberRoles: [{ role: { name: actorRole } }] }
          : {
              id: memberId,
              userId: 'other-user',
              deletedAt: null,
              memberRoles: [{ role: { name: targetRole } }],
            },
    );

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organizationMember.update).not.toHaveBeenCalled();
  });

  it('lets a higher-level non-owner remove a lower-level member', async () => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    manager.organizationMember.findFirst.mockImplementation(
      ({ where }: { where?: { userId?: string } }) =>
        where?.userId === actorId
          ? { memberRoles: [{ role: { name: 'ADMIN' } }] }
          : {
              id: memberId,
              userId: 'other-user',
              deletedAt: null,
              memberRoles: [{ role: { name: 'AUDITOR' } }],
            },
    );

    await service.removeForActor(actorId, organizationId, memberId);

    expect(manager.organizationMember.update).toHaveBeenCalledOnce();
  });

  it('lets the owner remove any member without a hierarchy lookup', async () => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: actorId,
    });

    await service.removeForActor(actorId, organizationId, memberId);

    expect(manager.organizationMember.findFirst).toHaveBeenCalledTimes(1);
    expect(manager.organizationMember.update).toHaveBeenCalledOnce();
  });

  it('rejects removal by an inactive actor before any lookup', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toMatchObject({ status: 401 });
    expect(manager.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it('does not publish an audit event when removal fails', async () => {
    const { service, manager, logging } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: 'different-owner',
    });
    logging.audit.mockRejectedValue(new Error('audit down'));

    await expect(
      service.removeForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('audit down');
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-member', null],
    [
      'a member of a deleted organization',
      {
        id: memberId,
        status: 'ACTIVE',
        deletedAt: null,
        organization: { ownerId: 'x', deletedAt: new Date(), isActive: false },
      },
    ],
    [
      'a member of an inactive organization',
      {
        id: memberId,
        status: 'ACTIVE',
        deletedAt: null,
        organization: { ownerId: 'x', deletedAt: null, isActive: false },
      },
    ],
  ])('forbids leaving as %s', async (_, membership) => {
    const { service, manager } = setup();
    manager.organizationMember.findUnique.mockResolvedValue(membership);

    await expect(
      service.leaveForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organizationMember.update).not.toHaveBeenCalled();
  });

  it('treats leaving twice as a no-op without a second audit event', async () => {
    const { service, manager, logging } = setup();
    manager.organizationMember.findUnique.mockResolvedValue({
      id: memberId,
      status: 'ACTIVE',
      deletedAt: new Date(),
      organization: { ownerId: 'x', deletedAt: null, isActive: true },
    });

    await expect(
      service.leaveForActor(actorId, organizationId),
    ).resolves.toBeUndefined();
    expect(manager.organizationMember.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});
