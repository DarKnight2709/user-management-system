import type { PermissionsService } from '@/common/services/permissions.service.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { InvitationAcceptanceService } from '../../services/invitation-acceptance.service.js';
import { InvitationCreationService } from '../../services/invitation-creation.service.js';
import type { InvitationEmailService } from '../../services/invitation-email.service.js';
import type { InvitationLinksService } from '../../services/invitation-links.service.js';
import { InvitationManagementService } from '../../services/invitation-management.service.js';
import { InvitationRulesService } from '../../services/invitation-rules.service.js';

interface InvitationServiceDependencies {
  prisma: PrismaService;
  permissions: PermissionsService;
  links: InvitationLinksService;
  email: InvitationEmailService;
  logging: LoggingService;
}

/** Wires the split invitation services the same way OrganizationsModule does. */
export function buildInvitationServices({
  prisma,
  permissions,
  links,
  email,
  logging,
}: InvitationServiceDependencies) {
  const rules = new InvitationRulesService(permissions, links);
  return {
    rules,
    creation: new InvitationCreationService(
      prisma,
      rules,
      links,
      email,
      logging,
    ),
    management: new InvitationManagementService(prisma, rules, email, logging),
    acceptance: new InvitationAcceptanceService(prisma, rules, links, logging),
  };
}

/** One object exposing every operation, for tests that exercise the whole flow. */
export function buildInvitationFlow(deps: InvitationServiceDependencies) {
  const { creation, management, acceptance } = buildInvitationServices(deps);
  return {
    create: creation.create.bind(creation),
    list: management.list.bind(management),
    resend: management.resend.bind(management),
    copyLink: management.copyLink.bind(management),
    revoke: management.revoke.bind(management),
    accept: acceptance.accept.bind(acceptance),
  };
}
