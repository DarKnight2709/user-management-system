import {
  Controller,
  Delete,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { MemberRolesService } from './member-roles.service.js';

@ApiTags('Organization Member Roles')
@ApiBearerAuth()
@Controller('organizations/:organizationId/members/:memberId/roles')
export class MemberRolesController {
  constructor(private readonly roles: MemberRolesService) {}

  @Put(':roleId')
  @HttpCode(204)
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_ROLE',
    action: 'assign',
  })
  @ApiOperation({ summary: 'Assign an organization role to an active member' })
  async assign(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<void> {
    await this.roles.assignForActor(actorId, organizationId, memberId, roleId);
  }

  @Delete(':roleId')
  @HttpCode(204)
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_ROLE',
    action: 'revoke',
  })
  @ApiOperation({
    summary: 'Revoke one organization role from an active member',
  })
  async revoke(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Param('roleId', ParseUUIDPipe) roleId: string,
  ): Promise<void> {
    await this.roles.revokeForActor(actorId, organizationId, memberId, roleId);
  }
}
