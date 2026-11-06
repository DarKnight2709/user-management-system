import { Module } from '@nestjs/common';
import { AuditEventReader } from './services/audit-event-reader.service.js';
import { AuditLogsController } from './audit-logs.controller.js';
import { AuditLogsService } from './audit-logs.service.js';
import { AuditViewRecorder } from './services/audit-view-recorder.service.js';
import { OrganizationAuditAccessService } from './services/organization-audit-access.service.js';

@Module({
  controllers: [AuditLogsController],
  providers: [
    AuditLogsService,
    AuditEventReader,
    AuditViewRecorder,
    OrganizationAuditAccessService,
  ],
})
export class AuditModule {}
