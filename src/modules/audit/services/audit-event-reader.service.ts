import { Injectable } from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import type { AuditTargetType } from '@/generated/prisma/enums.js';
import { AUDIT_EVENT_ORDER } from './constants/audit-logs.constant.js';
import type {
  AuditEventFilters,
  PaginatedAuditEvents,
} from './interfaces/audit-logs.interface.js';

/** Reads one filtered audit page and its total from a single transaction snapshot. */
@Injectable()
export class AuditEventReader {
  async readPage(
    manager: Prisma.TransactionClient,
    query: AuditEventFilters,
    scopedOrganizationId?: string,
  ): Promise<PaginatedAuditEvents> {
    const where = this.buildWhere(query, scopedOrganizationId);
    const [items, total] = await Promise.all([
      manager.auditEvent.findMany({
        where,
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        orderBy: AUDIT_EVENT_ORDER,
      }),
      manager.auditEvent.count({ where }),
    ]);
    return { items, total, page: query.page, limit: query.limit };
  }

  /** A route-scoped organization always wins over any client-supplied filter. */
  buildWhere(
    query: AuditEventFilters,
    scopedOrganizationId?: string,
  ): Prisma.AuditEventWhereInput {
    const organizationId = scopedOrganizationId ?? query.organizationId;
    return {
      ...(organizationId ? { organizationId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.targetType
        ? { targetType: query.targetType as AuditTargetType }
        : {}),
    };
  }
}
