import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequirePlatformPermissions } from '@/common/decorators/require-platform-permissions.decorator.js';
import { AdminOrganizationsService } from './admin-organizations.service.js';
import { ListAdminOrganizationsQueryDto } from './dto/list-admin-organizations-query.dto.js';
import { UpdateAdminOrganizationStatusDto } from './dto/update-admin-organization-status.dto.js';

@ApiTags('Admin Organizations')
@ApiBearerAuth()
@Controller('admin/organizations')
export class AdminOrganizationsController {
  constructor(private readonly organizations: AdminOrganizationsService) {}

  @Get()
  @RequirePlatformPermissions({ resource: 'ORGANIZATION', action: 'read' })
  @ApiOperation({ summary: 'List all organizations for platform admins' })
  list(
    @CurrentUser('id') actorId: string,
    @Query() query: ListAdminOrganizationsQueryDto,
  ) {
    return this.organizations.listForPlatformActor(actorId, query);
  }

  @Patch(':organizationId/status')
  @RequirePlatformPermissions({ resource: 'ORGANIZATION', action: 'update' })
  @ApiOperation({ summary: 'Suspend or reactivate an organization' })
  updateStatus(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateAdminOrganizationStatusDto,
  ) {
    return this.organizations.updateStatusForPlatformActor(
      actorId,
      organizationId,
      dto.status,
    );
  }
}
