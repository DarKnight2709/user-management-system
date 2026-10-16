import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { PlatformPermission } from '../decorators/require-platform-permissions.decorator.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type { OrganizationPermission } from '../decorators/require-organization-permissions.decorator.js';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  async hasOrganizationPermissions(
    userId: string,
    organizationId: string,
    required: OrganizationPermission[],
    manager: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    if (!organizationId.trim()) return false;
    const ids = await this.findAuthorizedOrganizationIds(
      userId,
      required,
      manager,
      organizationId,
    );
    return ids.length > 0;
  }

  async findAuthorizedOrganizationIds(
    userId: string,
    required: OrganizationPermission[],
    manager: Prisma.TransactionClient = this.prisma,
    organizationId?: string,
  ): Promise<string[]> {
    if (!userId.trim() || required.length === 0) return [];

    const memberships = await manager.organizationMember.findMany({
      where: {
        userId,
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        user: { deletedAt: null },
        organization: { deletedAt: null, isActive: true },
      },
      select: {
        organizationId: true,
        organization: { select: { ownerId: true } },
        memberRoles: {
          where: {
            deletedAt: null,
            role: {
              organizationId,
              isSystem: false,
              deletedAt: null,
              name: { not: 'OWNER' },
            },
          },
          select: {
            role: {
              select: {
                organizationId: true,
                rolePermissions: {
                  where: {
                    deletedAt: null,
                    permission: { deletedAt: null, OR: required },
                  },
                  select: {
                    permission: { select: { resource: true, action: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    return memberships
      .filter((membership) => {
        // Ownership still requires the active membership/user/organization filters.
        if (membership.organization.ownerId === userId) return true;
        const granted = membership.memberRoles
          // During listing there is no single organizationId filter. Reject even
          // malformed cross-organization assignments before considering their grants.
          .filter(
            ({ role }) => role.organizationId === membership.organizationId,
          )
          .flatMap(({ role }) =>
            role.rolePermissions.map(({ permission }) => permission),
          );
        return required.every((needed) =>
          granted.some(
            (permission) =>
              permission.resource === needed.resource &&
              permission.action === needed.action,
          ),
        );
      })
      .map((membership) => membership.organizationId);
  }

  hasPlatformPermission(
    userId: string,
    permission: PlatformPermission,
    manager?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return this.hasPlatformPermissions(userId, [permission], manager);
  }

  async hasPlatformPermissions(
    userId: string,
    required: PlatformPermission[],
    manager: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    if (!userId.trim() || required.length === 0) return false;

    const assignments = await manager.userPlatformRole.findMany({
      where: {
        userId,
        deletedAt: null,
        user: { deletedAt: null },
        role: {
          isSystem: true,
          organizationId: null,
          deletedAt: null,
        },
      },
      select: {
        role: {
          select: {
            rolePermissions: {
              where: {
                deletedAt: null,
                permission: { deletedAt: null, OR: required },
              },
              select: {
                permission: { select: { action: true, resource: true } },
              },
            },
          },
        },
      },
    });

    const grantedPermissions = assignments.flatMap(({ role }) =>
      role.rolePermissions.map(({ permission }) => permission),
    );

    return required.every((needed) =>
      grantedPermissions.some(
        (granted) =>
          granted.resource === needed.resource &&
          granted.action === needed.action,
      ),
    );
  }
}
