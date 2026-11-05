import { ForbiddenException, Injectable } from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { UpdateOrganizationDto } from './dto/update-organization.dto.js';
import { organizationDetailsSelect } from './constants/organization.constant.js';
import type { ListOrganizationsInput } from './interfaces/organizations.interface.js';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async findAllForActor({
    actorId,
    page = 1,
    limit = 20,
  }: ListOrganizationsInput) {
    assertValidPagination(page, limit);

    return this.prisma.serializableTransaction(async (manager) => {
      await this.permissions.assertActiveActor(actorId, manager);
      const authorizedIds =
        await this.permissions.findAuthorizedOrganizationIds(
          actorId,
          [{ resource: 'ORGANIZATION', action: 'read' }],
          manager,
        );
      const where = {
        id: { in: authorizedIds },
        deletedAt: null,
        isActive: true,
      };
      const [items, total] = await Promise.all([
        manager.organization.findMany({
          where,
          select: organizationDetailsSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        manager.organization.count({ where }),
      ]);
      return { items, total, page, limit };
    });
  }

  async findOneForActor(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction(async (manager) => {
      await this.permissions.assertActiveActor(actorId, manager);
      await this.assertOrganizationPermission(
        manager,
        { actorId, organizationId },
        'read',
      );
      return manager.organization.findUniqueOrThrow({
        where: { id: organizationId, deletedAt: null, isActive: true },
        select: organizationDetailsSelect,
      });
    });
  }

  async updateForActor(
    actorId: string,
    organizationId: string,
    dto: UpdateOrganizationDto,
  ) {
    const { result, auditEvent } = await this.prisma.serializableTransaction(
      (manager) =>
        this.updateInTransaction(manager, { actorId, organizationId }, dto),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  currentPermissions(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction((manager) =>
      this.permissions.getEffectiveOrganizationPermissions(
        actorId,
        organizationId,
        manager,
      ),
    );
  }

  private async updateInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, organizationId }: { actorId: string; organizationId: string },
    dto: UpdateOrganizationDto,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);
    await this.assertOrganizationPermission(
      manager,
      { actorId, organizationId },
      'update',
    );
    const current = await manager.organization.findUniqueOrThrow({
      where: { id: organizationId, deletedAt: null, isActive: true },
      select: organizationDetailsSelect,
    });
    if (current.name === dto.name) {
      return { result: current, auditEvent: null };
    }

    const updated = await manager.organization.update({
      where: { id: organizationId, deletedAt: null, isActive: true },
      // Explicit allowlist also protects direct service calls from mass assignment.
      data: { name: dto.name },
      select: organizationDetailsSelect,
    });
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.updated',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION', id: organizationId },
        organizationId,
        payload: {
          before: { name: current.name },
          after: { name: updated.name },
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
    return { result: updated, auditEvent };
  }

  // Missing and inaccessible organizations produce the same response.
  private async assertOrganizationPermission(
    manager: Prisma.TransactionClient,
    { actorId, organizationId }: { actorId: string; organizationId: string },
    action: 'read' | 'update',
  ): Promise<void> {
    const allowed = await this.permissions.hasOrganizationPermissions(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION', action }],
      manager,
    );
    if (!allowed) throw new ForbiddenException('Organization access denied');
  }
}
