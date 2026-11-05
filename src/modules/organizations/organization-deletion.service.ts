import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { OrganizationSnapshot } from './interfaces/organizations.interface.js';

const DELETION_DENIED_MESSAGE = 'Organization deletion access denied';

@Injectable()
export class OrganizationDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async deleteForActor(actorId: string, organizationId: string): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.deleteInTransaction(manager, actorId, organizationId),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async deleteInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
    const organization = await this.authorizeDeletion(
      manager,
      actorId,
      organizationId,
    );
    if (organization.deletedAt) return null;

    const deletedAt = new Date();
    await manager.organization.update({
      where: { id: organizationId, deletedAt: null },
      data: { deletedAt, isActive: false },
    });
    const revokedInvitations = await manager.organizationInvitation.updateMany({
      where: { organizationId, status: 'PENDING' },
      data: { status: 'REVOKED', revokedAt: deletedAt },
    });

    return this.logging.audit(
      {
        action: 'organization.deleted',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION', id: organizationId },
        organizationId,
        payload: {
          name: organization.name,
          slug: organization.slug,
          ownerId: organization.ownerId,
          revokedPendingInvitationCount: revokedInvitations.count,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  /** Platform deleters may target any organization; others must be its active owner. */
  private async authorizeDeletion(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ): Promise<OrganizationSnapshot> {
    const isPlatformDeleter = await this.permissions.hasPlatformPermission(
      actorId,
      { resource: 'ORGANIZATION', action: 'delete' },
      manager,
    );
    const organization = await manager.organization.findUnique({
      where: { id: organizationId },
      select: { ownerId: true, deletedAt: true, name: true, slug: true },
    });
    if (!organization) {
      // Only platform deleters may learn that an organization does not exist.
      if (isPlatformDeleter)
        throw new NotFoundException('Organization not found');
      throw new ForbiddenException(DELETION_DENIED_MESSAGE);
    }
    if (isPlatformDeleter) return organization;

    const isActiveOwner =
      organization.ownerId === actorId &&
      (await this.hasActiveMembership(manager, actorId, organizationId));
    if (!isActiveOwner) throw new ForbiddenException(DELETION_DENIED_MESSAGE);
    return organization;
  }

  private async hasActiveMembership(
    manager: Prisma.TransactionClient,
    userId: string,
    organizationId: string,
  ): Promise<boolean> {
    const membership = await manager.organizationMember.findFirst({
      where: { organizationId, userId, status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
    return membership !== null;
  }
}
