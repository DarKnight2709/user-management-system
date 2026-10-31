import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { RequirePlatformPermissions } from '@/common/decorators/require-platform-permissions.decorator.js';
import { UserRateLimit } from '@/common/decorators/user-rate-limit.decorator.js';
import { AuditLogsService } from './audit-logs.service.js';
import {
  ListOrganizationAuditEventsQueryDto,
  ListPlatformAuditEventsQueryDto,
} from './dto/list-audit-events-query.dto.js';

@ApiTags('Audit logs')
@ApiBearerAuth()
@Controller()
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get('audit-logs')
  @UserRateLimit(20)
  @Header('Cache-Control', 'no-store')
  @RequirePlatformPermissions({ resource: 'AUDIT_LOG', action: 'read' })
  @ApiOperation({ summary: 'List platform-wide audit events' })
  listPlatform(
    @CurrentUser('id') actorId: string,
    @Query() query: ListPlatformAuditEventsQueryDto,
  ) {
    return this.auditLogs.listPlatform(actorId, query);
  }

  @Get('organizations/:organizationId/audit-logs')
  @UserRateLimit(20)
  @Header('Cache-Control', 'no-store')
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_AUDIT_LOG',
    action: 'read',
  })
  @ApiOperation({ summary: 'List audit events for one organization' })
  listOrganization(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListOrganizationAuditEventsQueryDto,
  ) {
    return this.auditLogs.listOrganization(actorId, organizationId, query);
  }
}
