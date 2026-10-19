import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@/generated/prisma/client.js';
import { validateSync } from 'class-validator';
import { CreateOrganizationRoleDto } from './dto/create-organization-role.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';

const catalogFilter = organizationPermissions.map(({ resource, action }) => ({
  resource,
  action,
}));

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
      where: { id: actorId, deletedAt: null },
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
    const input = Object.assign(new CreateOrganizationRoleDto(), {
      name:
        typeof dto.name === 'string' ? dto.name.trim().toUpperCase() : dto.name,
      permissionIds: dto.permissionIds,
    });
    if (validateSync(input).length)
      throw new UnprocessableEntityException(
        'Invalid role name or permission IDs',
      );

    return await this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId, 'create');
      const permissions = await manager.permission.findMany({
        where: {
          id: { in: input.permissionIds },
          deletedAt: null,
          OR: catalogFilter,
        },
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
        select: { id: true, resource: true, action: true, description: true },
      });
      // check that all requested permissions are valid and active catalog entries
      if (permissions.length !== input.permissionIds.length) {
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
      const existing = await manager.role.findFirst({
        where: {
          organizationId,
          name: { equals: input.name, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (existing)
        throw new ConflictException(
          'Role name is already reserved in this organization',
        );
      const role = await manager.role.create({
        data: {
          organizationId,
          name: input.name,
          isSystem: false,
          rolePermissions: {
            create: permissions.map(({ id }) => ({ permissionId: id })),
          },
        },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
      return { ...role, isBuiltIn: false, permissions };
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
        where: { deletedAt: null, OR: catalogFilter },
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
        select: { id: true, resource: true, action: true, description: true },
      });
    });
  }
}
