import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
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
  ): Promise<void> {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action: 'read' }],
      manager,
    );
    if (!allowed)
      throw new ForbiddenException('Organization role access denied');
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
