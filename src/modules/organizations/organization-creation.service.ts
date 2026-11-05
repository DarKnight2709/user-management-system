import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
  defaultAdminPermissions,
  isDefaultMemberPermission,
} from './constants/organization.constant.js';
import type { DefaultRolePermission } from './interfaces/organizations.interface.js';

@Injectable()
export class OrganizationCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async createForActor(actorId: string, dto: CreateOrganizationDto) {
    const { organization, auditEvent } =
      await this.prisma.serializableTransaction((manager) =>
        this.createInTransaction(manager, actorId, dto),
      );
    this.logging.publishCommittedAudit(auditEvent);
    return organization;
  }

  private async createInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    { name, slug }: CreateOrganizationDto,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
    await this.assertSlugAvailable(manager, slug);
    const defaultPermissions = await this.loadDefaultPermissions(manager);

    const organization = await manager.organization.create({
      data: { name, slug, ownerId: actorId },
    });
    await manager.organizationMember.create({
      data: {
        organizationId: organization.id,
        userId: actorId,
        status: 'ACTIVE',
      },
    });
    await this.createDefaultRoles(manager, organization.id, defaultPermissions);

    // Ownership comes from ownerId and active membership, not an OWNER role.
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.created',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION', id: organization.id },
        organizationId: organization.id,
        payload: {
          name: organization.name,
          slug: organization.slug,
          ownerId: organization.ownerId,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
    return { organization, auditEvent };
  }

  // Soft-deleted organizations keep their slug reserved.
  private async assertSlugAvailable(
    manager: Prisma.TransactionClient,
    slug: string,
  ): Promise<void> {
    const existing = await manager.organization.findUnique({
      where: { slug },
      select: { id: true },
    });
    if (existing)
      throw new ConflictException('Organization slug is already taken');
  }

  private async loadDefaultPermissions(
    manager: Prisma.TransactionClient,
  ): Promise<DefaultRolePermission[]> {
    const permissions = await manager.permission.findMany({
      where: { deletedAt: null, OR: [...defaultAdminPermissions] },
      select: { id: true, resource: true, action: true },
    });
    if (permissions.length !== defaultAdminPermissions.length) {
      // Never create partially configured roles or silently restore revoked permissions.
      throw new ServiceUnavailableException(
        'Organization permissions are not configured',
      );
    }
    return permissions;
  }

  private async createDefaultRoles(
    manager: Prisma.TransactionClient,
    organizationId: string,
    permissions: DefaultRolePermission[],
  ): Promise<void> {
    const defaultRoles = [
      { name: ADMIN_ROLE_NAME, grants: permissions },
      {
        name: MEMBER_ROLE_NAME,
        grants: permissions.filter(isDefaultMemberPermission),
      },
    ];
    for (const { name, grants } of defaultRoles) {
      await manager.role.create({
        data: {
          name,
          organizationId,
          isSystem: false,
          rolePermissions: {
            create: grants.map(({ id }) => ({ permissionId: id })),
          },
        },
      });
    }
  }
}
