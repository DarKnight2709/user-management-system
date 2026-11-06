import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type {
  ListOrganizationMembersInput,
  MemberDirectoryQuery,
} from './interfaces/organization-members.interface.js';
import { localRoleFilter } from './utils/member-role.util.js';

/** Read-only member directory; membership changes live in the removal service. */
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
    search,
    roleId,
  }: ListOrganizationMembersInput) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction((manager) =>
      this.listMembersInTransaction(manager, {
        actorId,
        organizationId,
        page,
        limit,
        search,
        roleId,
      }),
    );
  }

  private async listMembersInTransaction(
    manager: Prisma.TransactionClient,
    {
      actorId,
      organizationId,
      page,
      limit,
      search,
      roleId,
    }: ListOrganizationMembersInput & { page: number; limit: number },
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
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
    const where = this.buildMemberDirectoryFilter(
      organizationId,
      search,
      roleId,
    );
    const { memberships, total } = await this.findMemberPage(manager, {
      organizationId,
      where,
      page,
      limit,
    });

    return {
      items: memberships.map((membership) =>
        this.mapMemberDirectoryEntry(membership, organization.ownerId),
      ),
      total,
      page,
      limit,
    };
  }

  private buildMemberDirectoryFilter(
    organizationId: string,
    search: string | undefined,
    roleId: string | undefined,
  ): Prisma.OrganizationMemberWhereInput {
    const where: Prisma.OrganizationMemberWhereInput = {
      organizationId,
      status: 'ACTIVE',
      deletedAt: null,
      user: { deletedAt: null },
    };
    const searchTerms = search?.trim().split(/\s+/).filter(Boolean) ?? [];
    if (searchTerms.length > 0) {
      where.AND = searchTerms.map((term) => ({
        user: {
          OR: [
            { username: { contains: term, mode: 'insensitive' } },
            { firstName: { contains: term, mode: 'insensitive' } },
            { lastName: { contains: term, mode: 'insensitive' } },
          ],
        },
      }));
    }
    if (roleId) {
      where.memberRoles = {
        some: {
          roleId,
          deletedAt: null,
          role: localRoleFilter(organizationId),
        },
      };
    }
    return where;
  }

  private async findMemberPage(
    manager: Prisma.TransactionClient,
    { organizationId, where, page, limit }: MemberDirectoryQuery,
  ) {
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
              role: localRoleFilter(organizationId),
            },
            orderBy: { roleId: 'asc' },
            select: { role: { select: { id: true, name: true } } },
          },
        },
      }),
      manager.organizationMember.count({ where }),
    ]);

    return { memberships, total };
  }

  private mapMemberDirectoryEntry(
    membership: {
      id: string;
      status: 'ACTIVE' | 'INVITED' | 'SUSPENDED';
      createdAt: Date;
      user: {
        id: string;
        username: string;
        firstName: string;
        lastName: string;
      };
      memberRoles: { role: { id: string; name: string } }[];
    },
    ownerId: string,
  ) {
    const { memberRoles, ...member } = membership;
    return {
      ...member,
      isOwner: membership.user.id === ownerId,
      roles: memberRoles.map(({ role }) => role),
    };
  }
}
