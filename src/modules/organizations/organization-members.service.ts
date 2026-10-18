import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';

@Injectable()
export class OrganizationMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
  ) {}

  async findAllForActor({
    actorId,
    organizationId,
    page = 1,
    limit = 20,
  }: {
    actorId: string;
    organizationId: string;
    page?: number;
    limit?: number;
  }) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction(async (manager) => {
      const actor = await manager.user.findUnique({
        where: { id: actorId, deletedAt: null },
        select: { id: true },
      });
      if (!actor) throw new UnauthorizedException('Authentication required');
      const allowed = await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        [{ resource: 'ORGANIZATION_MEMBER', action: 'read' }],
        manager,
      );
      if (!allowed) throw new ForbiddenException('Organization access denied');
      const organization = await manager.organization.findUniqueOrThrow({
        where: { id: organizationId, deletedAt: null, isActive: true },
        select: { ownerId: true },
      });
      const where = {
        organizationId,
        status: 'ACTIVE' as const,
        deletedAt: null,
        user: { deletedAt: null },
      };
      const [memberships, total] = await Promise.all([
        manager.organizationMember.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
          select: {
            id: true,
            status: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
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
              orderBy: { roleId: 'asc' },
              select: { role: { select: { id: true, name: true } } },
            },
          },
        }),
        manager.organizationMember.count({ where }),
      ]);
      const items = memberships.map(({ memberRoles, ...membership }) => ({
        ...membership,
        isOwner: membership.user.id === organization.ownerId,
        roles: memberRoles.map(({ role }) => role),
      }));
      return { items, total, page, limit };
    });
  }
}
