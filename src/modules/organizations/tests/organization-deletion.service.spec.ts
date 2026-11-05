import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { OrganizationDeletionService } from '../organization-deletion.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const otherUserId = '523e4567-e89b-42d3-a456-426614174000';

const storedOrganization = (overrides: Record<string, unknown> = {}) => ({
  ownerId: actorId,
  deletedAt: null,
  name: 'Acme',
  slug: 'acme',
  ...overrides,
});

function setup() {
  const manager = {
    organization: {
      findUnique: vi.fn().mockResolvedValue(storedOrganization()),
      update: vi.fn().mockResolvedValue({}),
    },
    organizationMember: {
      findFirst: vi.fn().mockResolvedValue({ id: 'owner-membership' }),
    },
    organizationInvitation: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasPlatformPermission: vi.fn().mockResolvedValue(false),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new OrganizationDeletionService(
    createPrismaStub(manager),
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, auditEvent };
}

describe('OrganizationDeletionService.deleteForActor', () => {
  it('rejects inactive actors', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 401 });
    expect(manager.organization.update).not.toHaveBeenCalled();
  });

  it('lets the active owner soft-delete and deactivate the organization', async () => {
    const { service, manager } = setup();

    await service.deleteForActor(actorId, organizationId);

    expect(manager.organization.update).toHaveBeenCalledWith({
      where: { id: organizationId, deletedAt: null },
      data: { deletedAt: expect.any(Date), isActive: false },
    });
  });

  it('revokes pending invitations with the same timestamp', async () => {
    const { service, manager } = setup();

    await service.deleteForActor(actorId, organizationId);

    const { data } = manager.organization.update.mock.calls[0][0] as {
      data: { deletedAt: Date };
    };
    expect(manager.organizationInvitation.updateMany).toHaveBeenCalledWith({
      where: { organizationId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: data.deletedAt },
    });
  });

  it('does not touch memberships, roles or users', async () => {
    const { service, manager } = setup();

    await service.deleteForActor(actorId, organizationId);

    expect(Object.keys(manager).sort()).toEqual([
      'organization',
      'organizationInvitation',
      'organizationMember',
    ]);
    expect(manager.organizationMember).not.toHaveProperty('update');
  });

  it('allows the owner to delete an inactive organization', async () => {
    const { service, manager } = setup();
    manager.organization.findUnique.mockResolvedValue(
      storedOrganization({ isActive: false }),
    );

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).resolves.toBeUndefined();
    expect(manager.organization.update).toHaveBeenCalled();
  });

  it('denies an owner whose membership is no longer active', async () => {
    const { service, manager } = setup();
    manager.organizationMember.findFirst.mockResolvedValue(null);

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organization.update).not.toHaveBeenCalled();
  });

  it('denies members who are not the owner without checking membership', async () => {
    const { service, manager } = setup();
    manager.organization.findUnique.mockResolvedValue(
      storedOrganization({ ownerId: otherUserId }),
    );

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organizationMember.findFirst).not.toHaveBeenCalled();
  });

  it('answers 403 for a missing organization to ordinary callers', async () => {
    const { service, manager } = setup();
    manager.organization.findUnique.mockResolvedValue(null);

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers 404 for a missing organization to platform deleters', async () => {
    const { service, manager, permissions } = setup();
    permissions.hasPlatformPermission.mockResolvedValue(true);
    manager.organization.findUnique.mockResolvedValue(null);

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('lets platform deleters delete without membership or ownership', async () => {
    const { service, manager, permissions } = setup();
    permissions.hasPlatformPermission.mockResolvedValue(true);
    manager.organization.findUnique.mockResolvedValue(
      storedOrganization({ ownerId: otherUserId }),
    );

    await service.deleteForActor(actorId, organizationId);

    expect(manager.organizationMember.findFirst).not.toHaveBeenCalled();
    expect(manager.organization.update).toHaveBeenCalled();
  });

  it('checks the platform ORGANIZATION delete permission', async () => {
    const { service, permissions } = setup();

    await service.deleteForActor(actorId, organizationId);

    expect(permissions.hasPlatformPermission).toHaveBeenCalledWith(
      actorId,
      { resource: 'ORGANIZATION', action: 'delete' },
      expect.anything(),
    );
  });

  it('is an idempotent no-op for an already deleted organization', async () => {
    const { service, manager, logging } = setup();
    manager.organization.findUnique.mockResolvedValue(
      storedOrganization({ deletedAt: new Date('2026-03-01') }),
    );

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).resolves.toBeUndefined();

    expect(manager.organization.update).not.toHaveBeenCalled();
    expect(manager.organizationInvitation.updateMany).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('still rechecks authority for an already deleted organization', async () => {
    const { service, manager } = setup();
    manager.organization.findUnique.mockResolvedValue(
      storedOrganization({
        ownerId: otherUserId,
        deletedAt: new Date('2026-03-01'),
      }),
    );

    await expect(
      service.deleteForActor(actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('audits with the revoked invitation count and publishes after commit', async () => {
    const { service, logging, auditEvent } = setup();

    await service.deleteForActor(actorId, organizationId);

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.deleted',
        payload: {
          name: 'Acme',
          slug: 'acme',
          ownerId: actorId,
          revokedPendingInvitationCount: 2,
        },
      }),
      expect.anything(),
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });
});
