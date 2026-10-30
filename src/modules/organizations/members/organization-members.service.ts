import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';
import { randomUUID } from 'node:crypto';

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
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');

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
        // Retain assignments as history; fresh invitation acceptance resets roles on rejoin.
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
      },
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async removeForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');

        const allowed = await this.permissions.hasOrganizationPermissions(
          actorId,
          organizationId,
          [{ resource: 'ORGANIZATION_MEMBER', action: 'remove' }],
          manager,
        );
        if (!allowed)
          throw new ForbiddenException('Organization access denied');

        const organization = await manager.organization.findUniqueOrThrow({
          where: { id: organizationId, deletedAt: null, isActive: true },
          select: { ownerId: true },
        });
        const memberRoles = {
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
        const member = await manager.organizationMember.findFirst({
          where: { id: memberId, organizationId },
          select: {
            id: true,
            userId: true,
            deletedAt: true,
            memberRoles,
          },
        });
        if (!member)
          throw new NotFoundException('Organization member not found');
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
          // Permission grants the operation; hierarchy limits its targets.
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
      },
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
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
