import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
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
  );
  return { service, manager, permissions, prisma };
}

describe('OrganizationMembersService', () => {
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
