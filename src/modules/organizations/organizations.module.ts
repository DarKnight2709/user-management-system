import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationMembersController } from './organization-members.controller.js';
import { OrganizationMembersService } from './organization-members.service.js';

@Module({
  controllers: [OrganizationsController, OrganizationMembersController],
  providers: [OrganizationsService, OrganizationMembersService],
})
export class OrganizationsModule {}
