import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { memberLevel, memberRoleSelection } from './utils/member-role.util.js';

/** Ending a membership: self-service leave and permission-gated removal. */
@Injectable()
export class OrganizationMemberRemovalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async leaveForActor(actorId: string, organizationId: string): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.leaveInTransaction(manager, actorId, organizationId),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async removeForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.removeInTransaction(manager, actorId, organizationId, memberId),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async leaveInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
    const membership = await manager.organizationMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: actorId } },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        organization: {
          select: { ownerId: true, deletedAt: true, isActive: true },
        },
      },
    });
    if (
      !membership ||
      membership.organization.deletedAt ||
      !membership.organization.isActive
    ) {
      throw new ForbiddenException('Organization access denied');
    }
    if (membership.organization.ownerId === actorId) {
      throw new ConflictException(
        'Transfer ownership before leaving the organization',
      );
    }
    if (membership.status !== 'ACTIVE') {
      throw new ForbiddenException('Active membership required');
    }
    if (membership.deletedAt) return null;

    await manager.organizationMember.update({
      where: { id: membership.id, organizationId, userId: actorId },
      data: { deletedAt: new Date() },
    });
    return this.logging.audit(
      {
        action: 'organization.member.left',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_MEMBER', id: membership.id },
        organizationId,
        payload: { memberUserId: actorId },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private async removeInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    memberId: string,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
    await this.authorizeRemoval(manager, actorId, organizationId);

    const organization = await manager.organization.findUniqueOrThrow({
      where: { id: organizationId, deletedAt: null, isActive: true },
      select: { ownerId: true },
    });
    const memberRoles = memberRoleSelection(organizationId);
    const member = await manager.organizationMember.findFirst({
      where: { id: memberId, organizationId },
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        memberRoles,
      },
    });
    if (!member) throw new NotFoundException('Organization member not found');
    if (member.userId === organization.ownerId) {
      throw new ConflictException(
        'Transfer ownership before removing the owner',
      );
    }

    if (actorId !== organization.ownerId) {
      const actorMembership = await manager.organizationMember.findFirst({
        where: {
          organizationId,
          userId: actorId,
          status: 'ACTIVE',
          deletedAt: null,
        },
        select: { memberRoles },
      });
      if (
        !actorMembership ||
        memberLevel(actorMembership.memberRoles) <=
          memberLevel(member.memberRoles)
      ) {
        throw new ForbiddenException(
          'Only members with a higher role level can remove this member',
        );
      }
    }
    if (member.deletedAt) return null;

    await manager.organizationMember.update({
      where: { id: member.id, organizationId },
      data: { deletedAt: new Date() },
    });
    return this.logging.audit(
      {
        action: 'organization.member.removed',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_MEMBER', id: member.id },
        organizationId,
        payload: { memberUserId: member.userId },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private async authorizeRemoval(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ): Promise<void> {
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_MEMBER', action: 'remove' }],
      manager,
    );
    if (!allowed) throw new ForbiddenException('Organization access denied');
  }
}
