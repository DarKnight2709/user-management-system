import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';
import { randomUUID } from 'node:crypto';

type Operation = 'assign' | 'revoke';

@Injectable()
export class MemberRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async assignForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
    roleId: string,
  ): Promise<void> {
    await this.changeForActor(
      actorId,
      organizationId,
      memberId,
      roleId,
      'assign',
    );
  }

  async revokeForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
    roleId: string,
  ): Promise<void> {
    await this.changeForActor(
      actorId,
      organizationId,
      memberId,
      roleId,
      'revoke',
    );
  }

  private async changeForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
    roleId: string,
    operation: Operation,
  ): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.authorize(manager, actorId, organizationId, operation);
        const member = await manager.organizationMember.findFirst({
          where: {
            id: memberId,
            organizationId,
            status: 'ACTIVE',
            deletedAt: null,
            user: { deletedAt: null },
          },
          select: { id: true, userId: true },
        });
        if (!member)
          throw new NotFoundException('Active organization member not found');
        const role = await manager.role.findFirst({
          where: {
            id: roleId,
            organizationId,
            isSystem: false,
            deletedAt: null,
          },
          select: {
            id: true,
            name: true,
            rolePermissions: {
              where: { deletedAt: null, permission: { deletedAt: null } },
              select: {
                permission: { select: { resource: true, action: true } },
              },
            },
          },
        });
        if (!role)
          throw new NotFoundException('Active organization role not found');
        if (role.name.toUpperCase() === 'OWNER')
          throw new ForbiddenException(
            'Ownership cannot be assigned or revoked as a role',
          );
        await this.assertDelegationAllowed(
          manager,
          actorId,
          organizationId,
          role,
        );

        if (operation === 'revoke') {
          const revoked = await manager.memberRole.updateMany({
            where: { organizationMemberId: memberId, roleId, deletedAt: null },
            data: { deletedAt: new Date() },
          });
          if (revoked.count === 0) return null;
        } else {
          const assigned = await this.assign(manager, memberId, roleId);
          if (!assigned) return null;
        }

        return this.logging.audit(
          {
            action:
              operation === 'assign'
                ? 'organization.member_role.assigned'
                : 'organization.member_role.revoked',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION_MEMBER', id: member.id },
            organizationId,
            payload: {
              memberUserId: member.userId,
              roleId: role.id,
              roleName: role.name,
            },
            requestContext: {
              requestId: requestContext.getStore()?.requestId ?? randomUUID(),
            },
          },
          manager,
        );
      },
    );

    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async authorize(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    operation: Operation,
  ): Promise<void> {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action: operation }],
      manager,
    );
    if (!allowed)
      throw new ForbiddenException(
        'Organization role assignment access denied',
      );
  }

  private async assertDelegationAllowed(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    role: {
      name: string;
      rolePermissions: { permission: { resource: string; action: string } }[];
    },
  ): Promise<void> {
    const organization = await manager.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { ownerId: true },
    });
    const isOwner = organization.ownerId === actorId;
    if (role.name.toUpperCase() === 'ADMIN' && !isOwner) {
      throw new ForbiddenException('Only the owner can assign or revoke ADMIN');
    }
    const required = role.rolePermissions.map(({ permission }) => permission);
    const inCatalog = required.every((p) =>
      organizationPermissions.some(
        (c) => c.resource === p.resource && c.action === p.action,
      ),
    );
    if (!inCatalog)
      throw new ForbiddenException(
        'Role contains permissions outside the organization catalog',
      );
    if (
      !isOwner &&
      required.length &&
      !(await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        required,
        manager,
      ))
    ) {
      throw new ForbiddenException(
        'Cannot assign or revoke a role beyond your organization authority',
      );
    }
  }

  private async assign(
    manager: Prisma.TransactionClient,
    memberId: string,
    roleId: string,
  ): Promise<boolean> {
    const where = {
      organizationMemberId_roleId: { organizationMemberId: memberId, roleId },
    };
    const existing = await manager.memberRole.findUnique({
      where,
      select: { deletedAt: true },
    });
    if (existing && existing.deletedAt === null) return false;
    await manager.memberRole.upsert({
      where,
      create: { organizationMemberId: memberId, roleId },
      update: { deletedAt: null },
    });
    return true;
  }
}
