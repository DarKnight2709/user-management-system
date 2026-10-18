import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationMembersController } from './organization-members.controller.js';
import { OrganizationMembersService } from './organization-members.service.js';
import {
  InvitationsController,
  InvitationAcceptanceController,
} from './invitations/controllers/invitations.controller.js';
import { InvitationsService } from './invitations/services/invitations.service.js';
import { InvitationLinksService } from './invitations/services/invitation-links.service.js';
import { InvitationEmailService } from './invitations/services/invitation-email.service.js';
import { InvitationQueueModule } from './invitations/invitation-queue.module.js';

@Module({
  imports: [InvitationQueueModule],
  controllers: [
    OrganizationsController,
    OrganizationMembersController,
    InvitationsController,
    InvitationAcceptanceController,
  ],
  providers: [
    OrganizationsService,
    OrganizationMembersService,
    InvitationsService,
    InvitationLinksService,
    InvitationEmailService,
  ],
})
export class OrganizationsModule {}
