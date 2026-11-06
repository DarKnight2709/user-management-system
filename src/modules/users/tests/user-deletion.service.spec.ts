import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { UserDeletionService } from '../user-deletion.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const targetId = '423e4567-e89b-42d3-a456-426614174000';

function setup() {
  const manager = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ deletedAt: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    userPlatformRole: { findFirst: vi.fn().mockResolvedValue(null) },
    organization: { findFirst: vi.fn().mockResolvedValue(null) },
    refreshToken: {
      updateMany: vi.fn().mockResolvedValue({ count: 3 }),
    },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasPlatformPermission: vi.fn().mockResolvedValue(true),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new UserDeletionService(
    createPrismaStub(manager),
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, permissions, logging, auditEvent };
}

describe('UserDeletionService.delete', () => {
  it('rejects inactive actors before any lookup', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(service.delete({ actorId, targetId })).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.user.findUnique).not.toHaveBeenCalled();
    expect(manager.user.update).not.toHaveBeenCalled();
  });

  it('forbids deleting another user without USER:delete, before target lookup', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasPlatformPermission.mockResolvedValue(false);

    await expect(service.delete({ actorId, targetId })).rejects.toMatchObject({
      status: 403,
    });
    expect(permissions.hasPlatformPermission).toHaveBeenCalledWith(
      actorId,
      { resource: 'USER', action: 'delete' },
      manager,
    );
    expect(manager.user.findUnique).not.toHaveBeenCalled();
  });

  it('lets users delete themselves without checking platform permission', async () => {
    const { service, permissions, manager } = setup();

    await service.delete({ actorId, targetId: actorId });

    expect(permissions.hasPlatformPermission).not.toHaveBeenCalled();
    expect(manager.user.update).toHaveBeenCalledOnce();
  });

  it('returns 404 for a missing target after authorization', async () => {
    const { service, manager } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(service.delete({ actorId, targetId })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('is a no-op for an already deleted target', async () => {
    const { service, manager, logging } = setup();
    manager.user.findUnique.mockResolvedValue({ deletedAt: new Date() });

    await expect(
      service.delete({ actorId, targetId }),
    ).resolves.toBeUndefined();

    expect(manager.user.update).not.toHaveBeenCalled();
    expect(manager.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('blocks deleting an active SUPER_ADMIN, including self-deletion', async () => {
    const { service, manager } = setup();
    manager.userPlatformRole.findFirst.mockResolvedValue({ id: 'assignment' });

    await expect(
      service.delete({ actorId, targetId: actorId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.user.update).not.toHaveBeenCalled();
    expect(manager.userPlatformRole.findFirst).toHaveBeenCalledWith({
      where: {
        userId: actorId,
        deletedAt: null,
        role: {
          name: 'SUPER_ADMIN',
          isSystem: true,
          organizationId: null,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
  });

  it('blocks owners of undeleted organizations, including inactive ones', async () => {
    const { service, manager } = setup();
    manager.organization.findFirst.mockResolvedValue({ id: 'org' });

    await expect(service.delete({ actorId, targetId })).rejects.toMatchObject({
      status: 409,
    });
    expect(manager.organization.findFirst).toHaveBeenCalledWith({
      where: { ownerId: targetId, deletedAt: null },
      select: { id: true },
    });
    expect(manager.user.update).not.toHaveBeenCalled();
  });

  it('soft-deletes and revokes refresh tokens with one timestamp', async () => {
    const { service, manager } = setup();

    await service.delete({ actorId, targetId });

    const userUpdate = manager.user.update.mock.calls[0][0] as {
      where: unknown;
      data: { deletedAt: Date };
    };
    const tokenUpdate = manager.refreshToken.updateMany.mock.calls[0][0] as {
      where: unknown;
      data: { revokedAt: Date };
    };
    expect(userUpdate.where).toEqual({ id: targetId, deletedAt: null });
    expect(tokenUpdate.where).toEqual({ userId: targetId, revokedAt: null });
    expect(tokenUpdate.data.revokedAt).toBe(userUpdate.data.deletedAt);
  });

  it('audits in the transaction and publishes only after it commits', async () => {
    const { service, manager, logging, auditEvent } = setup();

    await service.delete({ actorId, targetId });

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.deleted',
        actor: { type: 'USER', id: actorId },
        target: { type: 'USER', id: targetId },
        payload: { selfDeletion: false, revokedRefreshTokenCount: 3 },
      }),
      manager,
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('does not publish when the transaction fails', async () => {
    const { service, manager, logging } = setup();
    manager.refreshToken.updateMany.mockRejectedValue(new Error('db'));

    await expect(service.delete({ actorId, targetId })).rejects.toThrow('db');
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});
