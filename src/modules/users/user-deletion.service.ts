import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';

/**
 * Shared self/admin deletion: authorize the actor, protect organization ownership
 * and the SUPER_ADMIN account, then soft-delete and revoke refresh sessions.
 * Memberships, role assignments, and the current avatar are retained.
 */
@Injectable()
export class UserDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async delete({
    actorId,
    targetId,
  }: {
    actorId: string;
    targetId: string;
  }): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.deleteInTransaction(manager, actorId, targetId),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async deleteInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    targetId: string,
  ) {
    // JWT authentication may have happened before this account was deleted.
    await this.permissions.assertActiveActor(actorId, manager);

    // Self-deletion needs no admin permission; deleting anyone else requires USER:delete.
    if (actorId !== targetId) {
      const allowed = await this.permissions.hasPlatformPermission(
        actorId,
        { resource: 'USER', action: 'delete' },
        manager,
      );
      if (!allowed) throw new ForbiddenException('Delete action not allowed');
    }

    // Authorize before lookup so unauthorized callers cannot probe target existence.
    const target = await manager.user.findUnique({
      where: { id: targetId },
      select: { deletedAt: true },
    });
    if (!target) throw new NotFoundException('User not found');
    // Repeat deletion is a no-op only after authenticating and authorizing the actor.
    if (target.deletedAt !== null) return null;

    await this.assertDeletionSafeguards(manager, targetId);

    // Both writes commit together; a revocation failure rolls back account deletion.
    const now = new Date();
    await manager.user.update({
      where: { id: targetId, deletedAt: null },
      data: { deletedAt: now },
    });
    const revoked = await manager.refreshToken.updateMany({
      where: { userId: targetId, revokedAt: null },
      data: { revokedAt: now },
    });

    return this.logging.audit(
      {
        action: 'user.deleted',
        actor: { type: 'USER', id: actorId },
        target: { type: 'USER', id: targetId },
        payload: {
          selfDeletion: actorId === targetId,
          revokedRefreshTokenCount: revoked.count,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private async assertDeletionSafeguards(
    manager: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    // No caller may delete an active SUPER_ADMIN, including that account itself.
    // Protection does not depend on its current permission set or other admin count.
    const superAdminAssignment = await manager.userPlatformRole.findFirst({
      where: {
        userId,
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
    if (superAdminAssignment) {
      throw new ConflictException('The SUPER_ADMIN account cannot be deleted');
    }

    const ownedOrganization = await manager.organization.findFirst({
      // Inactive organizations still need an owner; only soft-deleted ones are excluded.
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });
    if (ownedOrganization) {
      throw new ConflictException(
        'Transfer ownership or delete owned organizations before deleting this account',
      );
    }
  }
}
