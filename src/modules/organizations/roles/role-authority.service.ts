import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import {
  catalogPermissionFilter,
  permissionDetailsSelect,
} from './constants/organization-role.constant.js';
import type {
  RoleAction,
  RolePermission,
} from './interfaces/organization-roles.interface.js';
import { isAssignablePermission } from './utils/role-permissions.util.js';

@Injectable()
export class RoleAuthorityService {
  constructor(private readonly permissions: PermissionsService) {}

  async authorize(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    action: RoleAction,
  ): Promise<void> {
    await this.permissions.assertActiveActor(actorId, manager);
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action }],
      manager,
    );
    if (!allowed)
      throw new ForbiddenException('Organization role access denied');
  }

  /** Managing a role requires authority over its current grants, including deletion. */
  async assertCanManageRole(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    currentPermissions: RolePermission[],
  ): Promise<void> {
    const organization = await manager.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { ownerId: true },
    });
    if (organization.ownerId === actorId) return;

    const withinAuthority =
      currentPermissions.length === 0 ||
      (await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        currentPermissions,
        manager,
      ));
    if (!currentPermissions.every(isAssignablePermission) || !withinAuthority) {
      throw new ForbiddenException(
        'Cannot manage a role beyond your organization authority',
      );
    }
  }

  async loadGrantablePermissions(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    permissionIds: string[],
  ): Promise<RolePermission[]> {
    const permissions = await manager.permission.findMany({
      where: {
        id: { in: permissionIds },
        deletedAt: null,
        OR: catalogPermissionFilter,
      },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      select: permissionDetailsSelect,
    });
    const allRequestedAreAssignable =
      permissions.length === permissionIds.length &&
      permissions.every(isAssignablePermission);
    if (!allRequestedAreAssignable) {
      throw new UnprocessableEntityException(
        'Permissions must be active organization catalog entries',
      );
    }
    await this.assertActorHoldsPermissions(
      manager,
      actorId,
      organizationId,
      permissions,
    );
    return permissions;
  }

  async assertNameAvailable(
    manager: Prisma.TransactionClient,
    organizationId: string,
    name: string,
    excludedRoleId?: string,
  ): Promise<void> {
    const duplicate = await manager.role.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludedRoleId ? { id: { not: excludedRoleId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException(
        'Role name is already reserved in this organization',
      );
  }

  private async assertActorHoldsPermissions(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    permissions: RolePermission[],
  ): Promise<void> {
    if (permissions.length === 0) return;
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      permissions,
      manager,
    );
    if (!allowed) {
      throw new ForbiddenException(
        'Cannot grant permissions beyond your organization authority',
      );
    }
  }
}
