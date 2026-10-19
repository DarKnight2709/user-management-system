import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationMembersController } from './members/organization-members.controller.js';
import { OrganizationMembersService } from './members/organization-members.service.js';
import {
  InvitationsController,
  InvitationAcceptanceController,
} from './invitations/controllers/invitations.controller.js';
import { InvitationsService } from './invitations/services/invitations.service.js';
import { InvitationLinksService } from './invitations/services/invitation-links.service.js';
import { InvitationEmailService } from './invitations/services/invitation-email.service.js';
import { InvitationQueueModule } from './invitations/invitation-queue.module.js';
import { OrganizationRolesController } from './roles/organization-roles.controller.js';
import { OrganizationRolesService } from './roles/organization-roles.service.js';
import { MemberRolesController } from './members/member-roles.controller.js';
import { MemberRolesService } from './members/member-roles.service.js';

@Module({
  imports: [InvitationQueueModule],
  controllers: [
    MemberRolesController,
    OrganizationRolesController,
    OrganizationsController,
    OrganizationMembersController,
    InvitationsController,
    InvitationAcceptanceController,
  ],
  providers: [
    MemberRolesService,
    OrganizationRolesService,
    OrganizationsService,
    OrganizationMembersService,
    InvitationsService,
    InvitationLinksService,
    InvitationEmailService,
  ],
})
export class OrganizationsModule {}
