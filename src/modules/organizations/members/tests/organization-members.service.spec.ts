import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { OrganizationMembersService } from '../organization-members.service.js';

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
      }),
      findFirst: vi.fn(({ where }: { where?: { userId?: string } }) =>
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
  const service = new OrganizationMembersService(
    prisma as unknown as PrismaService,
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, prisma };
}

describe('OrganizationMembersService', () => {
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

  it('lists active members with role data and owner marker', async () => {
    const { service, manager } = setup();
    manager.organization.findUniqueOrThrow.mockResolvedValue({
      ownerId: actorId,
    });
    manager.organizationMember.findMany.mockResolvedValue([
      {
        id: memberId,
        status: 'ACTIVE',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        user: {
          id: actorId,
          username: 'owner',
          firstName: 'Owner',
          lastName: 'User',
        },
        memberRoles: [{ role: { id: 'role-id', name: 'ADMIN' } }],
      },
    ]);
    manager.organizationMember.count.mockResolvedValue(1);

    await expect(
      service.findAllForActor({
        actorId,
        organizationId,
        page: 1,
        limit: 20,
        search: ' owner ',
        roleId: 'role-id',
      }),
    ).resolves.toMatchObject({
      items: [{ id: memberId, isOwner: true, roles: [{ name: 'ADMIN' }] }],
      total: 1,
    });

    expect(manager.organizationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it('rejects invalid list pagination before opening a transaction', async () => {
    const { service, prisma } = setup();

    await expect(
      service.findAllForActor({ actorId, organizationId, page: 0, limit: 20 }),
    ).rejects.toThrow('Invalid pagination');
    expect(prisma.serializableTransaction).not.toHaveBeenCalled();
  });
});
