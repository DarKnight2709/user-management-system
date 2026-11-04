import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { AdminOrganizationsService } from '../admin-organizations.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';

function createOrganization(
  overrides: Partial<{
    isActive: boolean;
    deletedAt: Date | null;
  }> = {},
) {
  return {
    id: organizationId,
    name: 'Acme',
    slug: 'acme',
    ownerId: actorId,
    isActive: true,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    owner: {
      id: actorId,
      username: 'owner',
      firstName: 'Owner',
      lastName: 'User',
    },
    ...overrides,
  };
}

function setup() {
  const organization = createOrganization();
  const findMany = vi.fn().mockResolvedValue([organization]);
  const count = vi.fn().mockResolvedValue(1);
  const findUnique = vi.fn().mockResolvedValue(organization);
  const update = vi.fn().mockResolvedValue({
    ...organization,
    isActive: false,
  });
  const manager = {
    organization: { findMany, count, findUnique, update },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasPlatformPermission: vi.fn().mockResolvedValue(true),
  };
  const auditEvent = { id: 'audit-id' };
  const audit = vi.fn().mockResolvedValue(auditEvent);
  const publishCommittedAudit = vi.fn();
  const logging = { audit, publishCommittedAudit };
  const prisma = {
    serializableTransaction: vi.fn(
      async (
        operation: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => operation(manager as unknown as Prisma.TransactionClient),
    ),
  };
  const service = new AdminOrganizationsService(
    prisma as unknown as PrismaService,
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );

  return {
    service,
    manager,
    permissions,
    logging,
    prisma,
    auditEvent,
    organization,
  };
}

describe('AdminOrganizationsService', () => {
  describe('list', () => {
    it('returns paginated organizations with derived statuses', async () => {
      const { service } = setup();

      await expect(
        service.list(actorId, { page: 2, limit: 10 }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ status: 'ACTIVE' })],
        total: 1,
        page: 2,
        limit: 10,
      });
    });

    it('filters by search across organization name and slug', async () => {
      const { service, manager } = setup();

      await service.list(actorId, {
        page: 1,
        limit: 20,
        search: ' acme ',
      });

      expect(manager.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { name: { contains: ' acme ', mode: 'insensitive' } },
              { slug: { contains: ' acme ', mode: 'insensitive' } },
            ],
          },
        }),
      );
    });

    it.each([
      ['ACTIVE', { deletedAt: null, isActive: true }],
      ['SUSPENDED', { deletedAt: null, isActive: false }],
      ['DELETED', { deletedAt: { not: null } }],
    ] as const)('applies the %s status filter', async (status, filter) => {
      const { service, manager } = setup();

      await service.list(actorId, { page: 1, limit: 20, status });

      expect(manager.organization.count).toHaveBeenCalledWith({
        where: filter,
      });
    });

    it('uses deterministic ordering and pagination offsets', async () => {
      const { service, manager } = setup();

      await service.list(actorId, { page: 3, limit: 10 });

      expect(manager.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: 20,
          take: 10,
        }),
      );
    });

    it('rejects invalid pagination before opening a transaction', async () => {
      const { service, prisma } = setup();

      await expect(
        service.list(actorId, { page: 0, limit: 20 }),
      ).rejects.toThrow('Invalid pagination');
      expect(prisma.serializableTransaction).not.toHaveBeenCalled();
    });

    it('requires active actor and platform read permission', async () => {
      const { service, permissions } = setup();

      await service.list(actorId, { page: 1, limit: 20 });

      expect(permissions.assertActiveActor).toHaveBeenCalledWith(
        actorId,
        expect.anything(),
      );
      expect(permissions.hasPlatformPermission).toHaveBeenCalledWith(
        actorId,
        { resource: 'ORGANIZATION', action: 'read' },
        expect.anything(),
      );
    });

    it('rejects actors without platform read permission', async () => {
      const { service, permissions } = setup();
      permissions.hasPlatformPermission.mockResolvedValue(false);

      await expect(
        service.list(actorId, { page: 1, limit: 20 }),
      ).rejects.toThrow('Access denied');
    });
  });

  describe('updateStatus', () => {
    it('suspends an active organization and publishes audit after commit', async () => {
      const { service, manager, logging, auditEvent } = setup();

      await expect(
        service.updateStatus(actorId, organizationId, 'SUSPENDED'),
      ).resolves.toMatchObject({ status: 'SUSPENDED' });

      expect(manager.organization.update).toHaveBeenCalledWith({
        where: { id: organizationId, deletedAt: null },
        data: { isActive: false },
        select: expect.any(Object),
      });
      expect(logging.audit).toHaveBeenCalledOnce();
      expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
    });

    it('reactivates a suspended organization', async () => {
      const { service, manager, organization } = setup();
      organization.isActive = false;
      manager.organization.update.mockResolvedValue({
        ...organization,
        isActive: true,
      });

      await expect(
        service.updateStatus(actorId, organizationId, 'ACTIVE'),
      ).resolves.toMatchObject({ status: 'ACTIVE' });

      expect(manager.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { isActive: true } }),
      );
    });

    it('does not update or audit when status is unchanged', async () => {
      const { service, manager, logging } = setup();

      await expect(
        service.updateStatus(actorId, organizationId, 'ACTIVE'),
      ).resolves.toMatchObject({ status: 'ACTIVE' });

      expect(manager.organization.update).not.toHaveBeenCalled();
      expect(logging.audit).not.toHaveBeenCalled();
      expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    });

    it('returns not found when the organization does not exist', async () => {
      const { service, manager } = setup();
      manager.organization.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus(actorId, organizationId, 'SUSPENDED'),
      ).rejects.toThrow('Organization not found');
    });

    it('rejects deleted organizations', async () => {
      const { service, manager } = setup();
      manager.organization.findUnique.mockResolvedValue(
        createOrganization({ deletedAt: new Date() }),
      );

      await expect(
        service.updateStatus(actorId, organizationId, 'ACTIVE'),
      ).rejects.toThrow('A deleted organization cannot be reactivated');
    });

    it('requires platform update permission', async () => {
      const { service, permissions } = setup();
      permissions.hasPlatformPermission.mockResolvedValue(false);

      await expect(
        service.updateStatus(actorId, organizationId, 'SUSPENDED'),
      ).rejects.toThrow('Access denied');
      expect(permissions.hasPlatformPermission).toHaveBeenCalledWith(
        actorId,
        { resource: 'ORGANIZATION', action: 'update' },
        expect.anything(),
      );
    });

    it('includes the status transition in the audit payload', async () => {
      const { service, logging } = setup();

      await service.updateStatus(actorId, organizationId, 'SUSPENDED');

      expect(logging.audit).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'organization.status.changed',
          actor: { type: 'USER', id: actorId },
          target: { type: 'ORGANIZATION', id: organizationId },
          organizationId,
          payload: { before: 'ACTIVE', after: 'SUSPENDED' },
          requestContext: { requestId: expect.any(String) },
        }),
        expect.anything(),
      );
    });
  });
});
