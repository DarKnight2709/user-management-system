import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { ListOrganizationsQueryDto } from '../dto/list-organizations-query.dto.js';
import { OrganizationRolesService } from './organization-roles.service.js';

@ApiTags('Organization Roles')
@ApiBearerAuth()
@Controller('organizations/:organizationId/roles')
@RequireOrganizationPermissions({
  resource: 'ORGANIZATION_ROLE',
  action: 'read',
})
export class OrganizationRolesController {
  constructor(private readonly roles: OrganizationRolesService) {}

  @Get()
  @ApiOperation({
    summary: 'List organization roles and their active permissions',
  })
  list(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListOrganizationsQueryDto,
  ) {
    return this.roles.listForActor(actorId, organizationId, query);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'View the organization permission catalog' })
  catalog(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.roles.catalogForActor(actorId, organizationId);
  }
}
