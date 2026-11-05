import { Injectable } from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { ListOrganizationRolesQueryDto } from './dto/list-organization-roles-query.dto.js';
import {
  BUILT_IN_ROLE_NAMES,
  OWNER_ROLE_NAME,
  RESERVED_ROLE_NAMES,
  catalogPermissionFilter,
  permissionDetailsSelect,
  roleDetailsSelect,
} from './constants/organization-role.constant.js';
import { RoleAuthorityService } from './role-authority.service.js';
import { isAssignablePermission } from './utils/role-permissions.util.js';

const activeCatalogGrantFilter = {
  deletedAt: null,
  permission: { deletedAt: null, OR: catalogPermissionFilter },
} satisfies Prisma.RolePermissionWhereInput;

const isBuiltInRoleName = (name: string): boolean =>
  (BUILT_IN_ROLE_NAMES as readonly string[]).includes(name);

@Injectable()
export class OrganizationRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly authority: RoleAuthorityService,
  ) {}

  async listForActor(
    actorId: string,
    organizationId: string,
    query: ListOrganizationRolesQueryDto,
  ) {
    const { page, limit } = query;
    assertValidPagination(page, limit);

    return this.prisma.serializableTransaction(async (manager) => {
      await this.authority.authorize(manager, actorId, organizationId, 'read');
      const where = this.buildRoleListFilter(organizationId, query);
      const [roles, total] = await Promise.all([
        manager.role.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            ...roleDetailsSelect,
            rolePermissions: {
              where: activeCatalogGrantFilter,
              orderBy: { permissionId: 'asc' },
              select: { permission: { select: permissionDetailsSelect } },
            },
          },
        }),
        manager.role.count({ where }),
      ]);
      const items = roles.map(({ rolePermissions, ...role }) => ({
        ...role,
        isBuiltIn: isBuiltInRoleName(role.name),
        permissions: rolePermissions.map(({ permission }) => permission),
      }));
      return { items, total, page, limit };
    });
  }

  async catalogForActor(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction(async (manager) => {
      await this.authority.authorize(manager, actorId, organizationId, 'read');
      const effectivePermissions =
        await this.permissions.getEffectiveOrganizationPermissions(
          actorId,
          organizationId,
          manager,
        );
      const grantableIds = effectivePermissions
        .filter(isAssignablePermission)
        .map(({ id }) => id);

      return manager.permission.findMany({
        where: {
          id: { in: grantableIds },
          deletedAt: null,
          OR: catalogPermissionFilter,
        },
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
        select: permissionDetailsSelect,
      });
    });
  }

  private buildRoleListFilter(
    organizationId: string,
    { search, type, permissionId }: ListOrganizationRolesQueryDto,
  ): Prisma.RoleWhereInput {
    return {
      organizationId,
      isSystem: false,
      deletedAt: null,
      name: {
        not: OWNER_ROLE_NAME,
        ...(search ? { contains: search, mode: 'insensitive' } : {}),
        ...(type === 'BUILT_IN' ? { in: [...BUILT_IN_ROLE_NAMES] } : {}),
        ...(type === 'CUSTOM' ? { notIn: [...RESERVED_ROLE_NAMES] } : {}),
      },
      ...(permissionId
        ? {
            rolePermissions: {
              some: { permissionId, ...activeCatalogGrantFilter },
            },
          }
        : {}),
    };
  }
}
