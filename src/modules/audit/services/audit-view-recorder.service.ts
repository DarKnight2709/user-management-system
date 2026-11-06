import { Injectable } from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { StoredAuditEvent } from '@/modules/logging/types/audit-event.types.js';
import type { AuditEventFilters } from './interfaces/audit-logs.interface.js';

/** Records `audit.log.viewed` in the same transaction as the page it describes. */
@Injectable()
export class AuditViewRecorder {
  constructor(private readonly logging: LoggingService) {}

  recordPlatformView(
    manager: Prisma.TransactionClient,
    actorId: string,
    requestId: string,
    query: AuditEventFilters,
  ): Promise<StoredAuditEvent> {
    return this.logging.audit(
      {
        action: 'audit.log.viewed',
        actor: { type: 'USER', id: actorId },
        target: { type: 'AUDIT_LOG', id: requestId },
        ...(query.organizationId
          ? { organizationId: query.organizationId }
          : {}),
        payload: {
          scope: 'PLATFORM',
          ...this.filterPayload(query),
          ...(query.organizationId
            ? { organizationFilter: query.organizationId }
            : {}),
        },
        requestContext: { requestId },
      },
      manager,
    );
  }

  recordOrganizationView(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
    requestId: string,
    query: AuditEventFilters,
  ): Promise<StoredAuditEvent> {
    return this.logging.audit(
      {
        action: 'audit.log.viewed',
        actor: { type: 'USER', id: actorId },
        target: { type: 'AUDIT_LOG', id: requestId },
        organizationId,
        payload: { scope: 'ORGANIZATION', ...this.filterPayload(query) },
        requestContext: { requestId },
      },
      manager,
    );
  }

  /** Publish after the surrounding transaction has committed. */
  publish(event: StoredAuditEvent): void {
    this.logging.publishCommittedAudit(event);
  }

  private filterPayload(query: AuditEventFilters) {
    return {
      page: query.page,
      limit: query.limit,
      ...(query.action ? { actionFilter: query.action } : {}),
      ...(query.actorId ? { actorIdFilter: query.actorId } : {}),
      ...(query.targetId ? { targetIdFilter: query.targetId } : {}),
      ...(query.targetType ? { targetTypeFilter: query.targetType } : {}),
    };
  }
}
