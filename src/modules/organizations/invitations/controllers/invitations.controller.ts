import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { RequireOrganizationPermissions } from '@/common/decorators/require-organization-permissions.decorator.js';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
} from '../dto/invitation.dto.js';
import { InvitationsService } from '../services/invitations.service.js';
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';
import { UserRateLimit } from '@/common/decorators/user-rate-limit.decorator.js';

@ApiTags('Organization Invitations')
@ApiBearerAuth()
@Controller('organizations/:organizationId/invitations')
@RequireOrganizationPermissions({
  resource: 'ORGANIZATION_MEMBER',
  action: 'invite',
})
@UserRateLimit(10)
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Create a MEMBER invitation and request email delivery',
  })
  create(
    @CurrentUser('id') actor: string,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Body() dto: CreateInvitationDto,
  ) {
    return this.invitations.create(actor, org, dto);
  }

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'List invitation metadata without tokens or links' })
  list(
    @CurrentUser('id') actor: string,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Query() query: ListOrganizationsQueryDto,
  ) {
    return this.invitations.list(actor, org, query);
  }

  @Post(':invitationId/resend')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @ApiOperation({ summary: 'Request invitation email again with cooldown' })
  resend(
    @CurrentUser('id') actor: string,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('invitationId', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.resend(actor, org, id);
  }

  @Post(':invitationId/link')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Copy a pending invitation link without sending email',
  })
  link(
    @CurrentUser('id') actor: string,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('invitationId', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.copyLink(actor, org, id);
  }

  @Delete(':invitationId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  revoke(
    @CurrentUser('id') actor: string,
    @Param('organizationId', ParseUUIDPipe) org: string,
    @Param('invitationId', ParseUUIDPipe) id: string,
  ) {
    return this.invitations.revoke(actor, org, id);
  }
}

@ApiTags('Organization Invitations')
@ApiBearerAuth()
@Controller('invitations')
export class InvitationAcceptanceController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('accept')
  @UserRateLimit(10)
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Accept using the invitation token and matching account email',
  })
  accept(@CurrentUser('id') actor: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(actor, dto.token);
  }
}
