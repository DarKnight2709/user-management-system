import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { OrganizationsService } from './organizations.service.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import { ListOrganizationsQueryDto } from './dto/list-organizations-query.dto.js';
import { UpdateOrganizationDto } from './dto/update-organization.dto.js';

@ApiTags('Organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Delete(':organizationId')
  @HttpCode(204)
  @ApiOperation({
    summary:
      'Soft-delete an organization as its owner or a platform administrator',
  })
  async delete(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ): Promise<void> {
    await this.organizationsService.deleteForActor(actorId, organizationId);
  }

  @Get(':organizationId/me/permissions')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'View your effective permissions in an organization',
  })
  currentPermissions(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
  ) {
    return this.organizationsService.currentPermissions(
      actorId,
      organizationId,
    );
  }

  @Patch(':organizationId')
  @RequireOrganizationPermissions({
    resource: 'ORGANIZATION',
    action: 'update',
  })
  @ApiOperation({ summary: 'Update organization name' })
  async update(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: UpdateOrganizationDto,
  ) {
    return this.organizationsService.updateForActor(
      actorId,
      organizationId,
      dto,
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List organizations accessible to the current user',
  })
  async findAll(
    @CurrentUser('id') actorId: string,
    @Query() query: ListOrganizationsQueryDto,
  ) {
    return this.organizationsService.findAllForActor({
      actorId,
      page: query.page,
      limit: query.limit,
    });
  }

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
