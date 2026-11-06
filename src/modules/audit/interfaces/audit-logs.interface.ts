import type { AuditEventModel } from '@/generated/prisma/models/AuditEvent.js';
import type { ListAuditEventsQueryDto } from '../dto/list-audit-events-query.dto.js';

export interface PaginatedAuditEvents {
  items: AuditEventModel[];
  total: number;
  page: number;
  limit: number;
}

export type AuditEventFilters = ListAuditEventsQueryDto & {
  organizationId?: string;
};
