import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import {
  BUILT_IN_ADMIN_ROLE_NAME,
  ORGANIZATION_AUDIT_DENIED_MESSAGE,
  ORGANIZATION_AUDIT_PERMISSION,
} from '../constants/audit-logs.constant.js';

/**
 * Organization audit history is limited to the owner or a built-in local ADMIN
 * who also holds the audit permission. Platform admins have no bypass.
 */
@Injectable()
export class OrganizationAuditAccessService {
  constructor(private readonly permissions: PermissionsService) {}

  async assertCanRead(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ): Promise<void> {
    const membership = await manager.organizationMember.findFirst({
      where: {
        userId: actorId,
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        user: { deletedAt: null },
        organization: { deletedAt: null, isActive: true },
      },
      select: {
        organization: { select: { ownerId: true } },
        memberRoles: {
          where: {
            deletedAt: null,
            role: { organizationId, isSystem: false, deletedAt: null },
          },
          select: { role: { select: { name: true } } },
        },
      },
    });
    if (!membership) {
      throw new ForbiddenException(ORGANIZATION_AUDIT_DENIED_MESSAGE);
    }

    const isOwner = membership.organization.ownerId === actorId;
    const isBuiltInAdmin = membership.memberRoles.some(
      ({ role }) => role.name === BUILT_IN_ADMIN_ROLE_NAME,
    );
    const hasPermission = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [ORGANIZATION_AUDIT_PERMISSION],
      manager,
    );
    if (!hasPermission || (!isOwner && !isBuiltInAdmin)) {
      throw new ForbiddenException(ORGANIZATION_AUDIT_DENIED_MESSAGE);
    }
  }
}
