import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client.js';
import type {
  ListOrganizationMembersInput,
  MemberDirectoryQuery,
} from './interfaces/organization-members.interface.js';

const currentRequestId = () =>
  requestContext.getStore()?.requestId ?? randomUUID();

@Injectable()
export class OrganizationMembersService {
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
    const memberRoles = this.buildMemberRoleSelection(organizationId);
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
        this.memberLevel(actorMembership.memberRoles) <=
          this.memberLevel(member.memberRoles)
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

  private buildMemberRoleSelection(organizationId: string) {
    return {
      where: {
        deletedAt: null,
        role: {
          organizationId,
          isSystem: false,
          deletedAt: null,
          name: { not: 'OWNER' },
        },
      },
      select: { role: { select: { name: true } } },
    } as const;
  }

  private memberLevel(assignments: { role: { name: string } }[]): number {
    // No role or MEMBER = 0, custom roles = 1, ADMIN = 2. Ownership is checked separately.
    return Math.max(
      0,
      ...assignments.map(({ role }) =>
        role.name === 'ADMIN' ? 2 : role.name === 'MEMBER' ? 0 : 1,
      ),
    );
  }

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
          role: {
            organizationId,
            isSystem: false,
            deletedAt: null,
            name: { not: 'OWNER' },
          },
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
