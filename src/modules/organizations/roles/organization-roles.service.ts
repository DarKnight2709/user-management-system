import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@/generated/prisma/client.js';
import { validateSync } from 'class-validator';
import { CreateOrganizationRoleDto } from './dto/create-organization-role.dto.js';
import { UpdateOrganizationRoleDto } from './dto/update-organization-role.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';

const catalogFilter = organizationPermissions.map(({ resource, action }) => ({
  resource,
  action,
}));

const permissionDetails = {
  id: true,
  resource: true,
  action: true,
  description: true,
} as const;
const roleDetails = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const;
type RolePermission = Prisma.PermissionGetPayload<{
  select: typeof permissionDetails;
}>;

const isCatalogPermission = (permission: {
  resource: string;
  action: string;
}) =>
  catalogFilter.some(
    (entry) =>
      entry.resource === permission.resource &&
      entry.action === permission.action,
  );

@Injectable()
export class OrganizationRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  private async authorize(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    action = 'read',
  ): Promise<void> {
    const actor = await manager.user.findUnique({
      where: {
        id: actorId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action }],
      manager,
    );
    if (!allowed)
      throw new ForbiddenException('Organization role access denied');
  }

  async createForActor(
    actorId: string,
    organizationId: string,
    dto: CreateOrganizationRoleDto,
  ) {
    const input = Object.assign(
      new CreateOrganizationRoleDto(),
      this.normalizeInput(dto),
    );
    if (validateSync(input).length) {
      throw new UnprocessableEntityException(
        'Invalid role name or permission IDs',
      );
    }

    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId, 'create');
      const permissions = await this.loadGrantablePermissions(
        manager,
        actorId,
        organizationId,
        input.permissionIds,
      );
      await this.assertNameAvailable(manager, organizationId, input.name);

      const role = await manager.role.create({
        data: {
          organizationId,
          name: input.name,
          isSystem: false,
          rolePermissions: {
            create: permissions.map(({ id }) => ({ permissionId: id })),
          },
        },
        select: roleDetails,
      });
      return { ...role, isBuiltIn: false, permissions };
    });
  }

  async updateForActor(
    actorId: string,
    organizationId: string,
    roleId: string,
    dto: UpdateOrganizationRoleDto,
  ) {
    const input = this.validateUpdate(dto);

    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId, 'update');
      const role = await this.findCustomRole(manager, organizationId, roleId);
      const currentPermissions = role.rolePermissions.map(
        ({ permission }) => permission,
      );
      await this.assertCanManageRole(
        manager,
        actorId,
        organizationId,
        currentPermissions,
      );

      if (input.name !== undefined) {
        await this.assertNameAvailable(
          manager,
          organizationId,
          input.name,
          roleId,
        );
      }
      const permissions =
        input.permissionIds === undefined
          ? currentPermissions.filter(isCatalogPermission)
          : await this.loadGrantablePermissions(
              manager,
              actorId,
              organizationId,
              input.permissionIds,
            );

      if (input.permissionIds !== undefined) {
        await this.replacePermissions(manager, roleId, input.permissionIds);
      }
      const updated = await manager.role.update({
        where: {
          id: roleId,
        },
        data: {
          updatedAt: new Date(),
          ...(input.name === undefined ? {} : { name: input.name }),
        },
        select: roleDetails,
      });
      return { ...updated, isBuiltIn: false, permissions };
    });
  }

  async deleteForActor(
    actorId: string,
    organizationId: string,
    roleId: string,
  ): Promise<void> {
    await this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId, 'delete');
      const role = await this.findCustomRole(
        manager,
        organizationId,
        roleId,
        true,
      );
      await this.assertCanManageRole(
        manager,
        actorId,
        organizationId,
        role.rolePermissions.map(({ permission }) => permission),
      );
      if (role.deletedAt) return;

      await manager.role.update({
        where: { id: role.id, organizationId },
        data: { deletedAt: new Date() },
      });
    });
  }

  async listForActor(
    actorId: string,
    organizationId: string,
    { page = 1, limit = 20 }: { page?: number; limit?: number },
  ) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId);
      const where = {
        organizationId,
        isSystem: false,
        deletedAt: null,
        name: { not: 'OWNER' },
      };
      const [roles, total] = await Promise.all([
        manager.role.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            name: true,
            createdAt: true,
            updatedAt: true,
            rolePermissions: {
              where: {
                deletedAt: null,
                permission: { deletedAt: null, OR: catalogFilter },
              },
              orderBy: { permissionId: 'asc' },
              select: {
                permission: {
                  select: {
                    id: true,
                    resource: true,
                    action: true,
                    description: true,
                  },
                },
              },
            },
          },
        }),
        manager.role.count({ where }),
      ]);
      const items = roles.map(({ rolePermissions, ...role }) => ({
        ...role,
        isBuiltIn: role.name === 'ADMIN' || role.name === 'MEMBER',
        permissions: rolePermissions.map(({ permission }) => permission),
      }));
      return { items, total, page, limit };
    });
  }

  async catalogForActor(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId);
      return manager.permission.findMany({
        where: {
          deletedAt: null,
          OR: catalogFilter,
        },
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
        select: { id: true, resource: true, action: true, description: true },
      });
    });
  }
  private normalizeInput(dto: UpdateOrganizationRoleDto) {
    return {
      name:
        typeof dto.name === 'string' ? dto.name.trim().toUpperCase() : dto.name,
      permissionIds: dto.permissionIds,
    };
  }

  private validateUpdate(
    dto: UpdateOrganizationRoleDto,
  ): UpdateOrganizationRoleDto {
    const input = Object.assign(
      new UpdateOrganizationRoleDto(),
      this.normalizeInput(dto),
    );
    const empty = input.name === undefined && input.permissionIds === undefined;
    if (empty || validateSync(input).length) {
      throw new UnprocessableEntityException(
        'Provide a valid role name or permission IDs',
      );
    }
    return input;
  }

  private async findCustomRole(
    manager: Prisma.TransactionClient,
    organizationId: string,
    roleId: string,
    includeDeleted = false,
  ) {
    const role = await manager.role.findFirst({
      where: {
        id: roleId,
        organizationId,
        isSystem: false,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      select: {
        id: true,
        name: true,
        deletedAt: true,
        rolePermissions: {
          where: {
            deletedAt: null,
            permission: { deletedAt: null },
          },
          orderBy: [
            { permission: { resource: 'asc' } },
            { permission: { action: 'asc' } },
          ],
          select: { permission: { select: permissionDetails } },
        },
      },
    });
    if (!role) throw new NotFoundException('Organization role not found');
    if (['OWNER', 'ADMIN', 'MEMBER'].includes(role.name.toUpperCase())) {
      throw new ForbiddenException('Built-in roles cannot be modified');
    }
    return role;
  }

  private async assertCanManageRole(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    permissions: RolePermission[],
  ) {
    const organization = await manager.organization.findUniqueOrThrow({
      where: {
        id: organizationId,
      },
      select: { ownerId: true },
    });
    if (organization.ownerId === actorId) return;

    // Managing a role requires authority over its current grants, including deletion.
    const withinAuthority =
      permissions.length === 0 ||
      (await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        permissions,
        manager,
      ));
    if (!permissions.every(isCatalogPermission) || !withinAuthority) {
      throw new ForbiddenException(
        'Cannot manage a role beyond your organization authority',
      );
    }
  }

  private async loadGrantablePermissions(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    permissionIds: string[],
  ): Promise<RolePermission[]> {
    const permissions = await manager.permission.findMany({
      where: {
        id: { in: permissionIds },
        deletedAt: null,
        OR: catalogFilter,
      },
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      select: permissionDetails,
    });

    if (permissions.length !== permissionIds.length) {
      throw new UnprocessableEntityException(
        'Permissions must be active organization catalog entries',
      );
    }
    if (
      permissions.length &&
      !(await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        permissions,
        manager,
      ))
    ) {
      throw new ForbiddenException(
        'Cannot grant permissions beyond your organization authority',
      );
    }
    return permissions;
  }

  private async assertNameAvailable(
    manager: Prisma.TransactionClient,
    organizationId: string,
    name: string,
    excludeRoleId?: string,
  ): Promise<void> {
    const duplicate = await manager.role.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeRoleId ? { id: { not: excludeRoleId } } : {}),
      },
      select: { id: true },
    });
    if (duplicate)
      throw new ConflictException(
        'Role name is already reserved in this organization',
      );
  }

  private async replacePermissions(
    manager: Prisma.TransactionClient,
    roleId: string,
    permissionIds: string[],
  ): Promise<void> {
    await manager.rolePermission.updateMany({
      where: {
        roleId,
        deletedAt: null,
        permissionId: { notIn: permissionIds },
      },
      data: { deletedAt: new Date() },
    });
    for (const permissionId of permissionIds) {
      await manager.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        create: { roleId, permissionId },
        update: { deletedAt: null },
      });
    }
  }
}
