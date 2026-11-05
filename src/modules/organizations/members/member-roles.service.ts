import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import type {
  ChangeMemberRoleInput,
  MemberRoleContext,
  MemberRoleTransaction,
  PermissionDelegationInput,
} from './interfaces/member-roles.interface.js';

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
    const input = { actorId, organizationId, memberId, roleId };
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.assignInTransaction({ manager, input }),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async revokeForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
    roleId: string,
  ): Promise<void> {
    const input = { actorId, organizationId, memberId, roleId };
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.revokeInTransaction({ manager, input }),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async assignInTransaction({ manager, input }: MemberRoleTransaction) {
    await this.authorizeRoleChange(manager, input, 'assign');
    const context = await this.loadContext(manager, input);
    await this.assertDelegationAllowed(manager, input, context.role);
    const assigned = await this.assign(manager, input);
    if (!assigned) return null;
    return this.audit(
      manager,
      input,
      context,
      'organization.member_role.assigned',
    );
  }

  private async revokeInTransaction({ manager, input }: MemberRoleTransaction) {
    await this.authorizeRoleChange(manager, input, 'revoke');
    const context = await this.loadContext(manager, input);
    await this.assertDelegationAllowed(manager, input, context.role);
    const revoked = await manager.memberRole.updateMany({
      where: {
        organizationMemberId: input.memberId,
        roleId: input.roleId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    if (revoked.count === 0) return null;
    return this.audit(
      manager,
      input,
      context,
      'organization.member_role.revoked',
    );
  }

  private async authorizeRoleChange(
    manager: Prisma.TransactionClient,
    { actorId, organizationId }: ChangeMemberRoleInput,
    action: 'assign' | 'revoke',
  ): Promise<void> {
    await this.permissions.assertActiveActor(actorId, manager);
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_ROLE', action }],
      manager,
    );
    if (!allowed)
      throw new ForbiddenException(
        'Organization role assignment access denied',
      );
  }

  private async loadContext(
    manager: Prisma.TransactionClient,
    { organizationId, memberId, roleId }: ChangeMemberRoleInput,
  ): Promise<MemberRoleContext> {
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
      where: { id: roleId, organizationId, isSystem: false, deletedAt: null },
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
    if (role.name.toUpperCase() === 'OWNER') {
      throw new ForbiddenException(
        'Ownership cannot be assigned or revoked as a role',
      );
    }
    return { member, role };
  }

  private async assertDelegationAllowed(
    manager: Prisma.TransactionClient,
    input: ChangeMemberRoleInput,
    role: MemberRoleContext['role'],
  ): Promise<void> {
    const { actorId, organizationId } = input;
    const organization = await manager.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { ownerId: true },
    });
    const isOwner = organization.ownerId === actorId;
    this.assertAdminDelegationAllowed(isOwner, role.name);

    const requiredPermissions = role.rolePermissions.map(
      ({ permission }) => permission,
    );
    this.assertCatalogPermissions(requiredPermissions);
    await this.assertPermissionDelegationAllowed({
      manager,
      input,
      isOwner,
      requiredPermissions,
    });
  }

  private assertAdminDelegationAllowed(
    isOwner: boolean,
    roleName: string,
  ): void {
    if (roleName.toUpperCase() === 'ADMIN' && !isOwner) {
      throw new ForbiddenException('Only the owner can assign or revoke ADMIN');
    }
  }

  private assertCatalogPermissions(
    permissions: { resource: string; action: string }[],
  ): void {
    const allPermissionsAreCatalogEntries = permissions.every((permission) =>
      organizationPermissions.some(
        (catalogPermission) =>
          catalogPermission.resource === permission.resource &&
          catalogPermission.action === permission.action,
      ),
    );
    if (!allPermissionsAreCatalogEntries) {
      throw new ForbiddenException(
        'Role contains permissions outside the organization catalog',
      );
    }
  }

  private async assertPermissionDelegationAllowed({
    manager,
    input: { actorId, organizationId },
    isOwner,
    requiredPermissions,
  }: PermissionDelegationInput): Promise<void> {
    if (
      isOwner ||
      requiredPermissions.length === 0 ||
      (await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        requiredPermissions,
        manager,
      ))
    ) {
      return;
    }
    throw new ForbiddenException(
      'Cannot assign or revoke a role beyond your organization authority',
    );
  }

  private async assign(
    manager: Prisma.TransactionClient,
    { memberId, roleId }: ChangeMemberRoleInput,
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

  private audit(
    manager: Prisma.TransactionClient,
    { actorId, organizationId }: ChangeMemberRoleInput,
    { member, role }: MemberRoleContext,
    action:
      'organization.member_role.assigned' | 'organization.member_role.revoked',
  ) {
    return this.logging.audit(
      {
        action,
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_MEMBER', id: member.id },
        organizationId,
        payload: {
          memberUserId: member.userId,
          roleId: role.id,
          roleName: role.name,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }
}
