import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PermissionsService } from '@/common/services/permissions.service.js';
import type {
  OrganizationInvitation,
  Prisma,
} from '@/generated/prisma/client.js';
import type { PreviousMembership } from '../interfaces/invitation.interface.js';
import { InvitationLinksService } from './invitation-links.service.js';

/** Authorization and eligibility rules shared by every invitation operation. */
@Injectable()
export class InvitationRulesService {
  constructor(
    private readonly permissions: PermissionsService,
    private readonly links: InvitationLinksService,
  ) {}

  async authorizeActor(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ): Promise<void> {
    await this.permissions.assertActiveActor(actorId, manager);
    if (
      !(await this.permissions.hasOrganizationPermissions(
        actorId,
        organizationId,
        [{ resource: 'ORGANIZATION_MEMBER', action: 'invite' }],
        manager,
      ))
    ) {
      throw new ForbiddenException('Organization invitation access denied');
    }
  }

  /** Returns the previous membership (if any) of an account that may be invited. */
  async assertInvitableAccount(
    manager: Prisma.TransactionClient,
    organizationId: string,
    email: string,
  ): Promise<PreviousMembership> {
    const account = await manager.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, deletedAt: true },
    });
    if (account?.deletedAt)
      throw new ConflictException('This account cannot be invited');

    if (!account) return null;

    const membership = await manager.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: account.id },
      },
      select: { id: true, status: true, deletedAt: true },
    });
    if (
      membership &&
      (membership.deletedAt === null || membership.status !== 'ACTIVE')
    ) {
      throw new ConflictException(
        'Account has an existing or suspended membership',
      );
    }
    return membership;
  }

  /** Pre-removal invitations must never restore access. */
  assertCreatedAfterRemoval(
    invitation: OrganizationInvitation,
    previousMembership: PreviousMembership,
  ): void {
    if (
      previousMembership?.deletedAt &&
      invitation.createdAt <= previousMembership.deletedAt
    ) {
      throw new ConflictException(
        'Create a new invitation after member removal',
      );
    }
  }

  assertPending(invitation: OrganizationInvitation): void {
    if (invitation.status !== 'PENDING' || invitation.expiresAt <= new Date()) {
      throw new ConflictException(
        'Invitation is no longer pending or has expired',
      );
    }
  }

  /** Rebuilds the link, failing if the token secret changed since creation. */
  createLink(invitation: OrganizationInvitation): string {
    if (!this.hasValidToken(invitation)) {
      throw new ServiceUnavailableException(
        'Invitation token configuration changed',
      );
    }
    return this.links.link(invitation.id);
  }

  hasValidToken(invitation: OrganizationInvitation): boolean {
    return (
      this.links.hash(this.links.token(invitation.id)) === invitation.tokenHash
    );
  }

  findInvitation(
    manager: Prisma.TransactionClient,
    organizationId: string,
    invitationId: string,
  ) {
    return manager.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId },
    });
  }
}
