import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto.js';
import { OrganizationOwnershipService } from './organization-ownership.service.js';

@ApiTags('Organization Ownership')
@ApiBearerAuth()
@Controller('organizations/:organizationId')
export class OrganizationOwnershipController {
  constructor(private readonly ownership: OrganizationOwnershipService) {}

  @Post('transfer-ownership')
  @HttpCode(200)
  @ApiOperation({ summary: 'Transfer ownership to another active member' })
  transfer(
    @CurrentUser('id') actorId: string,
    @Param('organizationId', ParseUUIDPipe) organizationId: string,
    @Body() dto: TransferOwnershipDto,
  ) {
    // Ownership is checked by ownerId in the service, not a delegable permission.
    return this.ownership.transferForActor(
      actorId,
      organizationId,
      dto.memberId,
    );
  }
}
