import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { OrganizationsService } from './organizations.service.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Get(':organizationId')
  @RequireOrganizationPermissions({ resource: 'ORGANIZATION', action: 'read' })
  @ApiOperation({ summary: 'View organization details' })
  async findOne(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizationsService.findOneForActor(actorId, organizationId);
  }

  @Post()
  @ApiOperation({ summary: 'Create an organization owned by the current user' })
  async create(
    @CurrentUser('id') actorId: string,
    @Body() dto: CreateOrganizationDto,
  ) {
    return this.organizationsService.create(actorId, dto);
  }
}
