import { ForbiddenException, Injectable } from '@nestjs/common';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { AuditEventReader } from './services/audit-event-reader.service.js';
import { AuditViewRecorder } from './services/audit-view-recorder.service.js';
import {
  PLATFORM_AUDIT_DENIED_MESSAGE,
  PLATFORM_AUDIT_PERMISSION,
} from './constants/audit-logs.constant.js';
import type {
  ListOrganizationAuditEventsQueryDto,
  ListPlatformAuditEventsQueryDto,
} from './dto/list-audit-events-query.dto.js';
import type { PaginatedAuditEvents } from './interfaces/audit-logs.interface.js';
import { OrganizationAuditAccessService } from './services/organization-audit-access.service.js';

/**
 * Audit history reads. Authorization, the page/count query and the
 * `audit.log.viewed` record share one serializable transaction; if the view
 * cannot be recorded the read fails. The Winston copy is published after commit.
 */
@Injectable()
export class AuditLogsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly access: OrganizationAuditAccessService,
    private readonly reader: AuditEventReader,
    private readonly views: AuditViewRecorder,
  ) {}

  async listPlatform(
    actorId: string,
    query: ListPlatformAuditEventsQueryDto,
  ): Promise<PaginatedAuditEvents> {
    assertValidPagination(query.page, query.limit);
    const requestId = currentRequestId();
    const { page, auditEvent } = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.permissions.assertActiveActor(actorId, manager);
        const allowed = await this.permissions.hasPlatformPermission(
          actorId,
          PLATFORM_AUDIT_PERMISSION,
          manager,
        );
        if (!allowed) {
          throw new ForbiddenException(PLATFORM_AUDIT_DENIED_MESSAGE);
        }

        const page = await this.reader.readPage(manager, query);
        const auditEvent = await this.views.recordPlatformView(
          manager,
          actorId,
          requestId,
          query,
        );
        return { page, auditEvent };
      },
    );

    this.views.publish(auditEvent);
    return page;
  }

  async listOrganization(
    actorId: string,
    organizationId: string,
    query: ListOrganizationAuditEventsQueryDto,
  ): Promise<PaginatedAuditEvents> {
    assertValidPagination(query.page, query.limit);
    const requestId = currentRequestId();
    const { page, auditEvent } = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.permissions.assertActiveActor(actorId, manager);
        await this.access.assertCanRead(manager, actorId, organizationId);

        const page = await this.reader.readPage(manager, query, organizationId);
        const auditEvent = await this.views.recordOrganizationView(
          manager,
          actorId,
          organizationId,
          requestId,
          query,
        );
        return { page, auditEvent };
      },
    );

    this.views.publish(auditEvent);
    return page;
  }
}
