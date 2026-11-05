import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { OrganizationOwnershipService } from '../organization-ownership.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const memberId = '123e4567-e89b-42d3-a456-426614174000';
const targetUserId = '523e4567-e89b-42d3-a456-426614174000';
const roleId = '423e4567-e89b-42d3-a456-426614174000';

function setup() {
  const manager = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: actorId }),
    },
    organizationMember: {
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ id: 'owner-membership-id' })
        .mockResolvedValueOnce({ userId: targetUserId }),
    },
    organization: {
      update: vi.fn().mockResolvedValue({
        id: organizationId,
        ownerId: targetUserId,
      }),
    },
    role: {
      findFirst: vi.fn().mockResolvedValue({ id: roleId }),
    },
    memberRole: {
      findUnique: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    },
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
  const service = new OrganizationOwnershipService(
    prisma as unknown as PrismaService,
    new PermissionsService(prisma as unknown as PrismaService),
    logging as unknown as LoggingService,
  );
  return { service, manager, logging, prisma, auditEvent };
}

describe('OrganizationOwnershipService', () => {
  it('transfers ownership and publishes audit after commit', async () => {
    const { service, manager, logging, auditEvent } = setup();

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).resolves.toEqual({
      id: organizationId,
      ownerId: targetUserId,
      previousOwnerId: actorId,
    });

    expect(manager.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerId: actorId }),
        data: { ownerId: targetUserId },
      }),
    );
    expect(logging.audit).toHaveBeenCalledOnce();
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('restores a missing MEMBER role for the former owner', async () => {
    const { service, manager } = setup();

    await service.transferForActor(actorId, organizationId, memberId);

    expect(manager.memberRole.upsert).toHaveBeenCalledWith({
      where: {
        organizationMemberId_roleId: {
          organizationMemberId: 'owner-membership-id',
          roleId,
        },
      },
      create: { organizationMemberId: 'owner-membership-id', roleId },
      update: { deletedAt: null },
    });
  });

  it('does not write a duplicate MEMBER role', async () => {
    const { service, manager } = setup();
    manager.memberRole.findUnique.mockResolvedValue({ deletedAt: null });

    await service.transferForActor(actorId, organizationId, memberId);

    expect(manager.memberRole.upsert).not.toHaveBeenCalled();
  });

  it('rejects unauthenticated actors', async () => {
    const { service, manager } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('Authentication required');
  });

  it('rejects actors who are not the active owner', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findFirst.mockReset().mockResolvedValue(null);

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('Only the active organization owner');
  });

  it('rejects missing target memberships', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: 'owner-membership-id' })
      .mockResolvedValueOnce(null);

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('Active organization member not found');
  });

  it('rejects transferring ownership to the current owner', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findFirst
      .mockReset()
      .mockResolvedValueOnce({ id: 'owner-membership-id' })
      .mockResolvedValueOnce({ userId: actorId });

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('Choose a different member');
  });

  it('fails without changing ownership when MEMBER role is unavailable', async () => {
    const { service, manager } = setup();
    manager.role.findFirst.mockResolvedValue(null);

    await expect(
      service.transferForActor(actorId, organizationId, memberId),
    ).rejects.toThrow('MEMBER role is unavailable');
    expect(manager.organization.update).not.toHaveBeenCalled();
  });
});
