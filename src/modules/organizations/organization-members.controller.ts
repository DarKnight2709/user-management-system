import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { ListOrganizationMembersQueryDto } from './dto/list-organization-members-query.dto.js';
import { OrganizationMembersService } from './organization-members.service.js';

@ApiTags('Organization Members')
@ApiBearerAuth()
@Controller('organizations/:organizationId/members')
export class OrganizationMembersController {
  constructor(private readonly members: OrganizationMembersService) {}

  @Get()
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION_MEMBER',
    action: 'read',
  })
  @ApiOperation({ summary: 'List active organization members' })
  async findAll(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Query() query: ListOrganizationMembersQueryDto,
  ) {
    return this.members.findAllForActor({
      actorId,
      organizationId,
      page: query.page,
      limit: query.limit,
    });
  }
}
