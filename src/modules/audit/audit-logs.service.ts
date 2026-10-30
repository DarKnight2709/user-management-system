import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@/generated/prisma/client.js';
import { AuditTargetType } from '@/generated/prisma/enums.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { requestContext } from '@/core/logging/request-context.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { ListAuditEventsQueryDto } from './dto/list-audit-events-query.dto.js';

const currentRequestId = () =>
  requestContext.getStore()?.requestId ?? randomUUID();

@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async listPlatform(
    actorId: string,
    query: ListAuditEventsQueryDto & { organizationId?: string },
  ) {
    assertValidPagination(query.page, query.limit);
    const requestId = currentRequestId();
    const result = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.assertActiveActor(manager, actorId);
        const allowed = await this.permissions.hasPlatformPermission(
          actorId,
          { resource: 'AUDIT_LOG', action: 'read' },
          manager,
        );
        if (!allowed) throw new ForbiddenException('Audit access denied');

        const where = this.buildWhere(query);
        const [items, total] = await Promise.all([
          manager.auditEvent.findMany({
            where,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
          }),
          manager.auditEvent.count({ where }),
        ]);

        const auditEvent = await this.logging.audit(
          {
            action: 'audit.log.viewed',
            actor: { type: 'USER', id: actorId },
            target: { type: 'AUDIT_LOG', id: requestId },
            ...(query.organizationId
              ? { organizationId: query.organizationId }
              : {}),
            payload: {
              scope: 'PLATFORM',
              page: query.page,
              limit: query.limit,
              ...(query.action ? { actionFilter: query.action } : {}),
              ...(query.actorId ? { actorIdFilter: query.actorId } : {}),
              ...(query.targetId ? { targetIdFilter: query.targetId } : {}),
              ...(query.targetType
                ? { targetTypeFilter: query.targetType }
                : {}),
              ...(query.organizationId
                ? { organizationFilter: query.organizationId }
                : {}),
            },
            requestContext: { requestId },
          },
          manager,
        );
        return {
          page: { items, total, page: query.page, limit: query.limit },
          auditEvent,
        };
      },
    );

    this.logging.publishCommittedAudit(result.auditEvent);
    return result.page;
  }

  async listOrganization(
    actorId: string,
    organizationId: string,
    query: ListAuditEventsQueryDto,
  ) {
    assertValidPagination(query.page, query.limit);
    const requestId = currentRequestId();
    const result = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.assertActiveActor(manager, actorId);
        const membership = await manager.organizationMember.findFirst({
          where: {
            userId: actorId,
            organizationId,
            status: 'ACTIVE',
            deletedAt: null,
            user: { deletedAt: null },
            organization: { deletedAt: null, isActive: true },
          },
          select: {
            organization: { select: { ownerId: true } },
            memberRoles: {
              where: {
                deletedAt: null,
                role: {
                  organizationId,
                  isSystem: false,
                  deletedAt: null,
                },
              },
              select: { role: { select: { name: true } } },
            },
          },
        });
        if (!membership) {
          throw new ForbiddenException('Organization audit access denied');
        }

        const isOwner = membership.organization.ownerId === actorId;
        const isBuiltInAdmin = membership.memberRoles.some(
          ({ role }) => role.name === 'ADMIN',
        );
        const hasPermission = await this.permissions.hasOrganizationPermissions(
          actorId,
          organizationId,
          [{ resource: 'ORGANIZATION_AUDIT_LOG', action: 'read' }],
          manager,
        );
        if (!hasPermission || (!isOwner && !isBuiltInAdmin)) {
          throw new ForbiddenException('Organization audit access denied');
        }

        const where = this.buildWhere(query, organizationId);
        const [items, total] = await Promise.all([
          manager.auditEvent.findMany({
            where,
            skip: (query.page - 1) * query.limit,
            take: query.limit,
            orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
          }),
          manager.auditEvent.count({ where }),
        ]);

        const auditEvent = await this.logging.audit(
          {
            action: 'audit.log.viewed',
            actor: { type: 'USER', id: actorId },
            target: { type: 'AUDIT_LOG', id: requestId },
            organizationId,
            payload: {
              scope: 'ORGANIZATION',
              page: query.page,
              limit: query.limit,
              ...(query.action ? { actionFilter: query.action } : {}),
              ...(query.actorId ? { actorIdFilter: query.actorId } : {}),
              ...(query.targetId ? { targetIdFilter: query.targetId } : {}),
              ...(query.targetType
                ? { targetTypeFilter: query.targetType }
                : {}),
            },
            requestContext: { requestId },
          },
          manager,
        );
        return {
          page: { items, total, page: query.page, limit: query.limit },
          auditEvent,
        };
      },
    );

    this.logging.publishCommittedAudit(result.auditEvent);
    return result.page;
  }

  private async assertActiveActor(
    manager: Prisma.TransactionClient,
    actorId: string,
  ): Promise<void> {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
  }

  private buildWhere(
    query: ListAuditEventsQueryDto & { organizationId?: string },
    scopedOrganizationId?: string,
  ): Prisma.AuditEventWhereInput {
    return {
      ...(scopedOrganizationId
        ? { organizationId: scopedOrganizationId }
        : query.organizationId
          ? { organizationId: query.organizationId }
          : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.targetType
        ? { targetType: query.targetType as AuditTargetType }
        : {}),
    };
  }
}
