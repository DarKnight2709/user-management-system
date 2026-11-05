import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { validateSync } from 'class-validator';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { CreateOrganizationRoleDto } from './dto/create-organization-role.dto.js';
import { UpdateOrganizationRoleDto } from './dto/update-organization-role.dto.js';
import {
  RESERVED_ROLE_NAMES,
  permissionDetailsSelect,
  roleDetailsSelect,
} from './constants/organization-role.constant.js';
import type {
  CreateRoleInput,
  CustomRole,
  RolePermission,
  RoleTarget,
  RoleTransaction,
  UpdateRoleChanges,
} from './interfaces/organization-roles.interface.js';
import { RoleAuthorityService } from './role-authority.service.js';
import {
  hasSameIds,
  isCatalogPermission,
  toAuditPermissions,
} from './utils/role-permissions.util.js';

type UpdateRoleInput = RoleTarget & { changes: UpdateRoleChanges };

const grantsOf = (role: CustomRole): RolePermission[] =>
  role.rolePermissions.map(({ permission }) => permission);

@Injectable()
export class OrganizationRoleManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: RoleAuthorityService,
    private readonly logging: LoggingService,
  ) {}

  async createForActor(
    actorId: string,
    organizationId: string,
    dto: CreateOrganizationRoleDto,
  ) {
    const { name, permissionIds } = this.parseCreateDto(dto);
    const input = { actorId, organizationId, name, permissionIds };

    const { result, auditEvent } = await this.prisma.serializableTransaction(
      (manager) => this.createInTransaction({ manager, input }),
    );
    this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  async updateForActor(target: RoleTarget, dto: UpdateOrganizationRoleDto) {
    const changes = this.parseUpdateDto(dto);
    const input = { ...target, changes };

    const { result, auditEvent } = await this.prisma.serializableTransaction(
      (manager) => this.updateInTransaction({ manager, input }),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  async deleteForActor(target: RoleTarget): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.deleteInTransaction({ manager, input: target }),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  private async createInTransaction({
    manager,
    input,
  }: RoleTransaction<CreateRoleInput>) {
    const { actorId, organizationId, name, permissionIds } = input;
    await this.authority.authorize(manager, actorId, organizationId, 'create');
    const permissions = await this.authority.loadGrantablePermissions(
      manager,
      actorId,
      organizationId,
      permissionIds,
    );
    await this.authority.assertNameAvailable(manager, organizationId, name);

    const role = await manager.role.create({
      data: {
        organizationId,
        name,
        isSystem: false,
        rolePermissions: {
          create: permissions.map(({ id }) => ({ permissionId: id })),
        },
      },
      select: roleDetailsSelect,
    });
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.role.created',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ROLE', id: role.id },
        organizationId,
        payload: {
          name: role.name,
          permissions: toAuditPermissions(permissions),
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );

    return { result: { ...role, isBuiltIn: false, permissions }, auditEvent };
  }

  private async updateInTransaction({
    manager,
    input,
  }: RoleTransaction<UpdateRoleInput>) {
    const { actorId, organizationId, roleId, changes } = input;
    await this.authority.authorize(manager, actorId, organizationId, 'update');
    const role = await this.findCustomRole(manager, input);
    const currentPermissions = grantsOf(role);
    await this.authority.assertCanManageRole(
      manager,
      actorId,
      organizationId,
      currentPermissions,
    );
    if (changes.name !== undefined) {
      await this.authority.assertNameAvailable(
        manager,
        organizationId,
        changes.name,
        roleId,
      );
    }
    const requestedPermissions =
      changes.permissionIds === undefined
        ? undefined
        : await this.authority.loadGrantablePermissions(
            manager,
            actorId,
            organizationId,
            changes.permissionIds,
          );

    const nameChanged =
      changes.name !== undefined && changes.name !== role.name;
    const permissionsChanged =
      changes.permissionIds !== undefined &&
      !hasSameIds(
        currentPermissions.map(({ id }) => id),
        changes.permissionIds,
      );
    const visiblePermissions =
      requestedPermissions ?? currentPermissions.filter(isCatalogPermission);

    if (!nameChanged && !permissionsChanged) {
      const { id, name, createdAt, updatedAt } = role;
      return {
        result: {
          id,
          name,
          createdAt,
          updatedAt,
          isBuiltIn: false,
          permissions: visiblePermissions,
        },
        auditEvent: null,
      };
    }

    if (permissionsChanged && changes.permissionIds !== undefined) {
      await this.replacePermissions(manager, roleId, changes.permissionIds);
    }
    const updated = await manager.role.update({
      where: { id: roleId },
      data: {
        updatedAt: new Date(),
        ...(nameChanged ? { name: changes.name } : {}),
      },
      select: roleDetailsSelect,
    });
    const permissionsAfter = permissionsChanged
      ? visiblePermissions
      : currentPermissions;
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.role.updated',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ROLE', id: role.id },
        organizationId,
        payload: {
          before: {
            name: role.name,
            permissions: toAuditPermissions(currentPermissions),
          },
          after: {
            name: updated.name,
            permissions: toAuditPermissions(permissionsAfter),
          },
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );

    return {
      result: { ...updated, isBuiltIn: false, permissions: visiblePermissions },
      auditEvent,
    };
  }

  private async deleteInTransaction({
    manager,
    input,
  }: RoleTransaction<RoleTarget>) {
    const { actorId, organizationId } = input;
    await this.authority.authorize(manager, actorId, organizationId, 'delete');
    const role = await this.findCustomRole(manager, input, {
      includeDeleted: true,
    });
    const currentPermissions = grantsOf(role);
    await this.authority.assertCanManageRole(
      manager,
      actorId,
      organizationId,
      currentPermissions,
    );
    if (role.deletedAt) return null;

    await manager.role.update({
      where: { id: role.id, organizationId },
      data: { deletedAt: new Date() },
    });
    return this.logging.audit(
      {
        action: 'organization.role.deleted',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ROLE', id: role.id },
        organizationId,
        payload: {
          name: role.name,
          permissions: toAuditPermissions(currentPermissions),
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private async findCustomRole(
    manager: Prisma.TransactionClient,
    { organizationId, roleId }: RoleTarget,
    { includeDeleted = false } = {},
  ): Promise<CustomRole> {
    const role = await manager.role.findFirst({
      where: {
        id: roleId,
        organizationId,
        isSystem: false,
        ...(includeDeleted ? {} : { deletedAt: null }),
      },
      select: {
        ...roleDetailsSelect,
        deletedAt: true,
        rolePermissions: {
          where: { deletedAt: null, permission: { deletedAt: null } },
          orderBy: [
            { permission: { resource: 'asc' } },
            { permission: { action: 'asc' } },
          ],
          select: { permission: { select: permissionDetailsSelect } },
        },
      },
    });
    if (!role) throw new NotFoundException('Organization role not found');
    if (this.isReservedName(role.name)) {
      throw new ForbiddenException('Built-in roles cannot be modified');
    }
    return role;
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

  private parseCreateDto(dto: CreateOrganizationRoleDto) {
    const input = Object.assign(new CreateOrganizationRoleDto(), {
      name: this.normalizeName(dto.name),
      permissionIds: dto.permissionIds,
    });
    if (validateSync(input).length) {
      throw new UnprocessableEntityException(
        'Invalid role name or permission IDs',
      );
    }
    return input;
  }

  private parseUpdateDto(dto: UpdateOrganizationRoleDto): UpdateRoleChanges {
    const input = Object.assign(new UpdateOrganizationRoleDto(), {
      name: this.normalizeName(dto.name),
      permissionIds: dto.permissionIds,
    });
    const isEmpty =
      input.name === undefined && input.permissionIds === undefined;
    if (isEmpty || validateSync(input).length) {
      throw new UnprocessableEntityException(
        'Provide a valid role name or permission IDs',
      );
    }
    return input;
  }

  // Service-level normalization also protects calls that bypass controller DTO transforms.
  private normalizeName<Name>(name: Name): Name | string {
    return typeof name === 'string' ? name.trim().toUpperCase() : name;
  }

  private isReservedName(name: string): boolean {
    return (RESERVED_ROLE_NAMES as readonly string[]).includes(
      name.toUpperCase(),
    );
  }
}
