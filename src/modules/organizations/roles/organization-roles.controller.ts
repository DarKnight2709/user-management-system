import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { ListOrganizationsQueryDto } from '../dto/list-organizations-query.dto.js';
import { OrganizationRolesService } from './organization-roles.service.js';
import { CreateOrganizationRoleDto } from './dto/create-organization-role.dto.js';
import { UpdateOrganizationRoleDto } from './dto/update-organization-role.dto.js';

@ApiTags('Organization Roles')
@ApiBearerAuth()
@Controller('organizations/:organizationId/roles')
@RequireOrganizationPermissions({
  resource: 'ORGANIZATION_ROLE',
  action: 'read',
})
export class OrganizationRolesController {
  constructor(private readonly roles: OrganizationRolesService) {}

  @Delete(':roleId')
  @HttpCode(204)
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_ROLE',
    action: 'delete',
  })
  @ApiOperation({ summary: 'Soft-delete a custom organization role' })
  async delete(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<void> {
    await this.roles.deleteForActor(actorId, organizationId, roleId);
  }

  @Patch(':roleId')
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_ROLE',
    action: 'update',
  })
  @ApiOperation({
    summary: 'Update a custom role name or replace its permissions',
  })
  update(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
    @Body() dto: UpdateOrganizationRoleDto,
  ) {
    return this.roles.updateForActor(actorId, organizationId, roleId, dto);
  }

  @Post()
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_ROLE',
    action: 'create',
  })
  @ApiOperation({
    summary: 'Create a custom organization role with selected permissions',
  })
  create(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: CreateOrganizationRoleDto,
  ) {
    return this.roles.createForActor(actorId, organizationId, dto);
  }

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
