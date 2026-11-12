import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type {
  OrganizationInvitation,
  Prisma,
} from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type {
  ActiveInvitationUser,
  JoinMemberInput,
  PreviousMembership,
} from '../interfaces/invitation.interface.js';
import { InvitationLinksService } from './invitation-links.service.js';
import { InvitationRulesService } from './invitation-rules.service.js';

/**
 * Accepts an invitation by capability token. Acceptance, membership and the
 * MEMBER assignment are atomic; the client never chooses roles.
 */
@Injectable()
export class InvitationAcceptanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: InvitationRulesService,
    private readonly links: InvitationLinksService,
    private readonly logging: LoggingService,
  ) {}

  async accept(actorId: string, token: string) {
    const { result, auditEvent } = await this.prisma.serializableTransaction(
      (manager) => this.acceptInTransaction(manager, actorId, token),
    );
    this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  private async acceptInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    token: string,
  ) {
    const user = await this.findActiveUser(manager, actorId);
    const invitation = await this.findValidInvitation(manager, token);
    this.assertInvitedEmail(user, invitation.email);

    const organization = await this.findActiveOrganization(
      manager,
      invitation.organizationId,
    );
    const previousMembership = await this.rules.assertInvitableAccount(
      manager,
      organization.id,
      invitation.email,
    );
    this.rules.assertCreatedAfterRemoval(invitation, previousMembership);

    const memberRoleId = await this.findMemberRoleId(manager, organization.id);
    const previousRoleIds = await this.findActiveRoleIds(
      manager,
      previousMembership,
    );

    await manager.organizationInvitation.update({
      where: { id: invitation.id, status: 'PENDING' },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
        acceptedById: user.id,
      },
    });
    const member = await this.joinAsMember(manager, {
      organizationId: organization.id,
      userId: user.id,
      roleId: memberRoleId,
      previousMembership,
    });
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.invitation.accepted',
        actor: { type: 'USER', id: user.id },
        target: {
          type: 'ORGANIZATION_INVITATION',
          id: invitation.id,
        },
        organizationId: organization.id,
        payload: {
          membershipId: member.id,
          membershipReactivated: Boolean(previousMembership?.deletedAt),
          previousRoleIds,
          memberRoleId,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
    return {
      result: { organizationId: organization.id, membershipId: member.id },
      auditEvent,
    };
  }

  private async findActiveUser(
    manager: Prisma.TransactionClient,
    actorId: string,
  ): Promise<ActiveInvitationUser> {
    const user = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }
    // The invitation went to a mailbox; only a verified address proves it is theirs.
    if (!user.emailVerifiedAt) {
      throw new ForbiddenException(
        'Verify your email address before accepting an invitation',
      );
    }
    return user;
  }

  private async findValidInvitation(
    manager: Prisma.TransactionClient,
    token: string,
  ): Promise<OrganizationInvitation> {
    const invitation = await manager.organizationInvitation.findUnique({
      where: { tokenHash: this.links.hash(token) },
    });
    if (!invitation || !this.rules.hasValidToken(invitation)) {
      throw new BadRequestException('Invalid invitation');
    }
    this.rules.assertPending(invitation);
    return invitation;
  }

  private assertInvitedEmail(
    user: ActiveInvitationUser,
    invitationEmail: string,
  ): void {
    if (user.email.trim().toLowerCase() !== invitationEmail) {
      throw new ForbiddenException('Sign in with the invited email address');
    }
  }

  private async findActiveOrganization(
    manager: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<{ id: string }> {
    const organization = await manager.organization.findUnique({
      where: {
        id: organizationId,
        deletedAt: null,
        isActive: true,
      },
      select: { id: true },
    });
    if (!organization) {
      throw new ConflictException('Organization is unavailable');
    }
    return organization;
  }

  private async findMemberRoleId(
    manager: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<string> {
    const role = await manager.role.findFirst({
      where: {
        organizationId,
        name: 'MEMBER',
        isSystem: false,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!role) {
      throw new ServiceUnavailableException(
        'Organization MEMBER role is unavailable',
      );
    }
    return role.id;
  }

  private async findActiveRoleIds(
    manager: Prisma.TransactionClient,
    previousMembership: PreviousMembership,
  ): Promise<string[]> {
    if (!previousMembership?.deletedAt) return [];

    const roles = await manager.memberRole.findMany({
      where: {
        organizationMemberId: previousMembership.id,
        deletedAt: null,
      },
      select: { roleId: true },
      orderBy: { roleId: 'asc' },
    });
    return roles.map(({ roleId }) => roleId);
  }

  private async joinAsMember(
    manager: Prisma.TransactionClient,
    input: JoinMemberInput,
  ) {
    const { organizationId, userId, roleId, previousMembership } = input;
    if (!previousMembership) {
      return this.createMemberWithRole(manager, {
        organizationId,
        userId,
        roleId,
      });
    }

    return this.restoreMemberWithRole(manager, input);
  }

  private createMemberWithRole(
    manager: Prisma.TransactionClient,
    input: Omit<JoinMemberInput, 'previousMembership'>,
  ) {
    const { organizationId, userId, roleId } = input;
    return manager.organizationMember.create({
      data: {
        organizationId,
        userId,
        status: 'ACTIVE',
        memberRoles: { create: { roleId } },
      },
      select: { id: true },
    });
  }

  private async restoreMemberWithRole(
    manager: Prisma.TransactionClient,
    input: JoinMemberInput,
  ) {
    const { organizationId, userId, roleId, previousMembership } = input;
    if (!previousMembership) {
      throw new ConflictException('Previous membership is required');
    }

    // Retained historical roles must never reactivate when membership is restored.
    await manager.memberRole.updateMany({
      where: {
        organizationMemberId: previousMembership.id,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    await manager.memberRole.upsert({
      where: {
        organizationMemberId_roleId: {
          organizationMemberId: previousMembership.id,
          roleId,
        },
      },
      create: { organizationMemberId: previousMembership.id, roleId },
      update: { deletedAt: null },
    });
    return manager.organizationMember.update({
      where: {
        id: previousMembership.id,
        organizationId,
        userId,
        status: 'ACTIVE',
        deletedAt: previousMembership.deletedAt,
      },
      data: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
  }
}
