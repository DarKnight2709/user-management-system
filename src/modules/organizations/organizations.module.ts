import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';
import { OrganizationCreationService } from './organization-creation.service.js';
import { OrganizationDeletionService } from './organization-deletion.service.js';
import { OrganizationMembersController } from './members/organization-members.controller.js';
import { OrganizationMembersService } from './members/organization-members.service.js';
import { OrganizationMemberRemovalService } from './members/organization-member-removal.service.js';
import {
  InvitationsController,
  InvitationAcceptanceController,
} from './invitations/invitations.controller.js';
import { InvitationCreationService } from './invitations/services/invitation-creation.service.js';
import { InvitationManagementService } from './invitations/services/invitation-management.service.js';
import { InvitationAcceptanceService } from './invitations/services/invitation-acceptance.service.js';
import { InvitationRulesService } from './invitations/services/invitation-rules.service.js';
import { InvitationLinksService } from './invitations/services/invitation-links.service.js';
import { InvitationEmailService } from './invitations/services/invitation-email.service.js';
import { InvitationQueueModule } from './invitations/invitation-queue.module.js';
import { OrganizationRolesController } from './roles/organization-roles.controller.js';
import { OrganizationRolesService } from './roles/organization-roles.service.js';
import { OrganizationRoleManagementService } from './roles/organization-role-management.service.js';
import { RoleAuthorityService } from './roles/role-authority.service.js';
import { MemberRolesController } from './members/member-roles.controller.js';
import { MemberRolesService } from './members/member-roles.service.js';
import { OrganizationOwnershipController } from './ownership/organization-ownership.controller.js';
import { OrganizationOwnershipService } from './ownership/organization-ownership.service.js';
import { AdminOrganizationsController } from './admin/admin-organizations.controller.js';
import { AdminOrganizationsService } from './admin/admin-organizations.service.js';

@Module({
  imports: [InvitationQueueModule],
  controllers: [
    OrganizationOwnershipController,
    AdminOrganizationsController,
    MemberRolesController,
    OrganizationRolesController,
    OrganizationsController,
    OrganizationMembersController,
    InvitationsController,
    InvitationAcceptanceController,
  ],
  providers: [
    OrganizationOwnershipService,
    AdminOrganizationsService,
    MemberRolesService,
    OrganizationRolesService,
    OrganizationRoleManagementService,
    RoleAuthorityService,
    OrganizationsService,
    OrganizationCreationService,
    OrganizationDeletionService,
    OrganizationMembersService,
    OrganizationMemberRemovalService,
    InvitationCreationService,
    InvitationManagementService,
    InvitationAcceptanceService,
    InvitationRulesService,
    InvitationLinksService,
    InvitationEmailService,
  ],
})
export class OrganizationsModule {}
