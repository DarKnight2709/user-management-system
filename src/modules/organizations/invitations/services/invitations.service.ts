import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type OrganizationInvitation,
} from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { InvitationLinksService } from './invitation-links.service.js';
import { InvitationEmailService } from './invitation-email.service.js';
import { CreateInvitationDto } from '../dto/invitation.dto.js';
import { ListInvitationsQueryDto } from '../dto/list-invitations-query.dto.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';

const INVITATION_EXPIRY_DAYS = 7;
const RESEND_COOLDOWN_MS = 60_000;
const MAX_RESEND_COUNT = 5;

const INVITATION_LIST_SELECT = {
  id: true,
  organizationId: true,
  email: true,
  status: true,
  expiresAt: true,
  invitedById: true,
  createdAt: true,
  resendCount: true,
  lastRequestedAt: true,
  deliveryStatus: true,
  sentAt: true,
} satisfies Prisma.OrganizationInvitationSelect;

type InvitationStatus = NonNullable<ListInvitationsQueryDto['status']>;

const INVITATION_STATUS_FILTERS: Partial<
  Record<
    InvitationStatus,
    (now: Date) => Prisma.OrganizationInvitationWhereInput
  >
> = {
  EXPIRED: (now) => ({
    OR: [
      { status: 'EXPIRED' },
      { status: 'PENDING', expiresAt: { lte: now } },
    ],
  }),
  PENDING: (now) => ({
    status: 'PENDING',
    expiresAt: { gt: now },
  }),
};

type PreviousMembership = {
  id: string;
  status: string;
  deletedAt: Date | null;
} | null;

type ActiveInvitationUser = {
  id: string;
  email: string;
};

type CreateInvitationInput = {
  actorId: string;
  organizationId: string;
  email: string;
  invitationId: string;
  tokenHash: string;
};

type ResendInvitationInput = {
  actorId: string;
  organizationId: string;
  invitationId: string;
};

type RevokeInvitationInput = {
  actorId: string;
  organizationId: string;
  invitationId: string;
};

type CopyInvitationLinkInput = {
  actorId: string;
  organizationId: string;
  invitationId: string;
};

type ListInvitationsInput = {
  actorId: string;
  organizationId: string;
  page: number;
  limit: number;
  email?: string;
  status?: ListInvitationsQueryDto['status'];
};

type InvitationListRecord = Prisma.OrganizationInvitationGetPayload<{
  select: typeof INVITATION_LIST_SELECT;
}>;

type JoinMemberInput = {
  organizationId: string;
  userId: string;
  roleId: string;
  previousMembership: PreviousMembership;
};

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly links: InvitationLinksService,
    private readonly email: InvitationEmailService,
    private readonly logging: LoggingService,
  ) {}

  async create(
    actorId: string,
    organizationId: string,
    dto: CreateInvitationDto,
  ) {
    const email = dto.email.trim().toLowerCase();
    const id = randomUUID();
    const tokenHash = this.links.hash(this.links.token(id));
    const { invitation, auditEvent } =
      await this.prisma.serializableTransaction((manager) =>
        this.createInvitationInTransaction(manager, {
          actorId,
          organizationId,
          email,
          invitationId: id,
          tokenHash,
        }),
      );
    this.logging.publishCommittedAudit(auditEvent);
    return this.enqueueInvitationEmail(invitation);
  }

  async resend(actorId: string, organizationId: string, invitationId: string) {
    const { invitation, auditEvent } =
      await this.prisma.serializableTransaction((manager) =>
        this.requestResendInTransaction(manager, {
          actorId,
          organizationId,
          invitationId,
        }),
      );
    this.logging.publishCommittedAudit(auditEvent);
    return this.enqueueInvitationEmail(invitation);
  }

  async copyLink(
    actorId: string,
    organizationId: string,
    invitationId: string,
  ) {
    return this.prisma.serializableTransaction((manager) =>
      this.copyInvitationLinkInTransaction(manager, {
        actorId,
        organizationId,
        invitationId,
      }),
    );
  }

  async revoke(actorId: string, organizationId: string, invitationId: string) {
    const auditEvent = await this.prisma.serializableTransaction(
      (manager) =>
        this.revokeInvitationInTransaction(manager, {
          actorId,
          organizationId,
          invitationId,
        }),
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async list(
    actorId: string,
    organizationId: string,
    { page = 1, limit = 20, email, status }: Partial<ListInvitationsQueryDto>,
  ) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction((manager) =>
      this.listInvitationsInTransaction(manager, {
        actorId,
        organizationId,
        page,
        limit,
        email,
        status,
      }),
    );
  }

  async accept(actorId: string, token: string) {
    const { result, auditEvent } = await this.prisma.serializableTransaction(
      (manager) => this.acceptInvitationInTransaction(manager, actorId, token),
    );
    this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  private async requestResendInTransaction(
    manager: Prisma.TransactionClient,
    input: ResendInvitationInput,
  ) {
    const { actorId, organizationId, invitationId } = input;
    await this.authorizeInvitationActor(manager, actorId, organizationId);
    const invitation = await this.findInvitation(
      manager,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    this.assertPending(invitation);
    this.createInvitationLink(invitation);
    const previousMembership = await this.assertInvitableAccount(
      manager,
      organizationId,
      invitation.email,
    );
    this.assertInvitationCreatedAfterRemoval(
      invitation,
      previousMembership,
    );
    this.assertResendAllowed(invitation);

    const updatedInvitation = await manager.organizationInvitation.update({
      where: { id: invitation.id },
      data: {
        resendCount: { increment: 1 },
        deliveryVersion: { increment: 1 },
        lastRequestedAt: new Date(),
        deliveryStatus: 'NOT_QUEUED',
        sentAt: null,
      },
    });
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.invitation.resend_requested',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_INVITATION', id: invitation.id },
        organizationId,
        payload: {
          deliveryVersion: updatedInvitation.deliveryVersion,
          resendCount: updatedInvitation.resendCount,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
    return { invitation: updatedInvitation, auditEvent };
  }

  private async revokeInvitationInTransaction(
    manager: Prisma.TransactionClient,
    input: RevokeInvitationInput,
  ) {
    const { actorId, organizationId, invitationId } = input;
    await this.authorizeInvitationActor(manager, actorId, organizationId);
    const invitation = await this.findInvitation(
      manager,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (invitation.status === 'REVOKED') return null;
    if (invitation.status === 'ACCEPTED') {
      throw new ConflictException('Accepted invitations cannot be revoked');
    }

    await manager.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return this.logging.audit(
      {
        action: 'organization.invitation.revoked',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_INVITATION', id: invitation.id },
        organizationId,
        payload: { deliveryVersion: invitation.deliveryVersion },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
  }

  private async copyInvitationLinkInTransaction(
    manager: Prisma.TransactionClient,
    input: CopyInvitationLinkInput,
  ) {
    const { actorId, organizationId, invitationId } = input;
    await this.authorizeInvitationActor(manager, actorId, organizationId);
    const invitation = await this.findInvitation(
      manager,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    this.assertPending(invitation);
    const previousMembership = await this.assertInvitableAccount(
      manager,
      organizationId,
      invitation.email,
    );
    this.assertInvitationCreatedAfterRemoval(
      invitation,
      previousMembership,
    );
    return {
      id: invitation.id,
      inviteLink: this.createInvitationLink(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  private async listInvitationsInTransaction(
    manager: Prisma.TransactionClient,
    input: ListInvitationsInput,
  ) {
    const { actorId, organizationId, page, limit } = input;
    await this.authorizeInvitationActor(manager, actorId, organizationId);
    const now = new Date();
    const where = this.buildInvitationListFilter(input, now);
    const [records, total] = await Promise.all([
      manager.organizationInvitation.findMany({
        where,
        select: INVITATION_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      manager.organizationInvitation.count({ where }),
    ]);
    return {
      items: records.map((record) => this.mapInvitationListRecord(record, now)),
      total,
      page,
      limit,
    };
  }

  private buildInvitationListFilter(
    input: ListInvitationsInput,
    now: Date,
  ): Prisma.OrganizationInvitationWhereInput {
    const { organizationId, email, status } = input;
    return {
      organizationId,
      ...(email && {
        email: { contains: email, mode: 'insensitive' },
      }),
      ...this.buildInvitationStatusFilter(status, now),
    };
  }

  private buildInvitationStatusFilter(
    status: ListInvitationsInput['status'],
    now: Date,
  ): Prisma.OrganizationInvitationWhereInput {
    if (!status) return {};
    return INVITATION_STATUS_FILTERS[status]?.(now) ?? { status };
  }

  private mapInvitationListRecord(
    record: InvitationListRecord,
    now: Date,
  ) {
    return {
      ...record,
      role: 'MEMBER' as const,
      status:
        record.status === 'PENDING' && record.expiresAt <= now
          ? 'EXPIRED' as const
          : record.status,
    };
  }

  private async authorizeInvitationActor(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ) {
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

  private async assertInvitableAccount(
    manager: Prisma.TransactionClient,
    organizationId: string,
    email: string,
  ) {
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

  private assertInvitationCreatedAfterRemoval(
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

  private assertPending(invitation: OrganizationInvitation): void {
    if (invitation.status !== 'PENDING' || invitation.expiresAt <= new Date()) {
      throw new ConflictException(
        'Invitation is no longer pending or has expired',
      );
    }
  }

  private createInvitationLink(invitation: OrganizationInvitation): string {
    if (
      this.links.hash(this.links.token(invitation.id)) !== invitation.tokenHash
    ) {
      throw new ServiceUnavailableException(
        'Invitation token configuration changed',
      );
    }
    return this.links.link(invitation.id);
  }

  private async enqueueInvitationEmail(invitation: OrganizationInvitation) {
    const emailQueued = await this.email.enqueue(
      invitation.id,
      invitation.deliveryVersion,
    );
    return {
      emailQueued,
    };
  }

  private findInvitation(
    manager: Prisma.TransactionClient,
    organizationId: string,
    invitationId: string,
  ) {
    return manager.organizationInvitation.findFirst({
      where: { id: invitationId, organizationId },
    });
  }

  private async createInvitationInTransaction(
    manager: Prisma.TransactionClient,
    {
      actorId,
      organizationId,
      email,
      invitationId,
      tokenHash,
    }: CreateInvitationInput,
  ) {
    await this.authorizeInvitationActor(manager, actorId, organizationId);
    const outsiderOrPreviousMembership = await this.assertInvitableAccount(
      manager,
      organizationId,
      email,
    );
    const now = this.getInvitationCreatedAt(outsiderOrPreviousMembership);
    const revokedStaleInvitationCount = await this.revokeStaleInvitations(
      manager,
      organizationId,
      email,
      outsiderOrPreviousMembership,
      now,
    );
    const expiredInvitationCount = await this.expirePendingInvitations(
      manager,
      organizationId,
      email,
      now,
    );
    await this.assertNoPendingInvitation(manager, organizationId, email);

    const invitation = await manager.organizationInvitation.create({
      data: {
        id: invitationId,
        organizationId,
        email,
        tokenHash,
        createdAt: now,
        invitedById: actorId,
        expiresAt: new Date(
          now.getTime() + INVITATION_EXPIRY_DAYS * 24 * 60 * 60 * 1_000,
        ),
        lastRequestedAt: now,
      },
    });
    const auditEvent = await this.logging.audit(
      {
        action: 'organization.invitation.created',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION_INVITATION', id: invitation.id },
        organizationId,
        payload: {
          expiresAt: invitation.expiresAt.toISOString(),
          expiredInvitationCount,
          revokedStaleInvitationCount,
        },
        requestContext: { requestId: currentRequestId() },
      },
      manager,
    );
    return { invitation, auditEvent };
  }

  private getInvitationCreatedAt(
    previousMembership: PreviousMembership,
  ): Date {
    return new Date(
      Math.max(
        Date.now(),
        (previousMembership?.deletedAt?.getTime() ?? 0) + 1,
      ),
    );
  }

  private async revokeStaleInvitations(
    manager: Prisma.TransactionClient,
    organizationId: string,
    email: string,
    previousMembership: PreviousMembership,
    createdAt: Date,
  ): Promise<number> {
    if (!previousMembership?.deletedAt) return 0;

    const revoked = await manager.organizationInvitation.updateMany({
      where: {
        organizationId,
        email,
        status: 'PENDING',
        createdAt: { lte: previousMembership.deletedAt },
      },
      data: { status: 'REVOKED', revokedAt: createdAt },
    });
    return revoked.count;
  }

  private async expirePendingInvitations(
    manager: Prisma.TransactionClient,
    organizationId: string,
    email: string,
    now: Date,
  ): Promise<number> {
    const expired = await manager.organizationInvitation.updateMany({
      where: {
        organizationId,
        email,
        status: 'PENDING',
        expiresAt: { lte: now },
      },
      data: { status: 'EXPIRED' },
    });
    return expired.count;
  }

  private async assertNoPendingInvitation(
    manager: Prisma.TransactionClient,
    organizationId: string,
    email: string,
  ): Promise<void> {
    const existing = await manager.organizationInvitation.findFirst({
      where: { organizationId, email, status: 'PENDING' },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        'A pending invitation already exists; use resend or copy link',
      );
    }
  }

  private assertResendAllowed(invitation: OrganizationInvitation): void {
    const elapsedMs = Date.now() - invitation.lastRequestedAt.getTime();
    const remainingMs = RESEND_COOLDOWN_MS - elapsedMs;

    if (remainingMs > 0) {
      throw new HttpException(
        {
          message: 'Wait before resending',
          retryAfterSeconds: Math.ceil(remainingMs / 1_000),
        },
        429,
      );
    }

    if (invitation.resendCount >= MAX_RESEND_COUNT) {
      throw new HttpException(
        'Invitation resend limit reached; copy link remains available',
        429,
      );
    }
  }

  private async acceptInvitationInTransaction(
    manager: Prisma.TransactionClient,
    actorId: string,
    token: string,
  ) {
    const user = await this.findActiveInvitationUser(manager, actorId);
    const invitation = await this.findValidInvitation(manager, token);
    this.assertInvitedEmail(user, invitation.email);

    const organization = await this.findActiveOrganization(
      manager,
      invitation.organizationId,
    );
    const previousMembership = await this.assertInvitableAccount(
      manager,
      organization.id,
      invitation.email,
    );
    this.assertInvitationCreatedAfterRemoval(
      invitation,
      previousMembership,
    );

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
    const member = await this.joinAsMember(
      manager,
      {
        organizationId: organization.id,
        userId: user.id,
        roleId: memberRoleId,
        previousMembership,
      },
    );
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

  private async findActiveInvitationUser(
    manager: Prisma.TransactionClient,
    actorId: string,
  ): Promise<ActiveInvitationUser> {
    const user = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) {
      throw new UnauthorizedException('Authentication required');
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
    if (!invitation || !this.hasValidInvitationToken(invitation)) {
      throw new BadRequestException('Invalid invitation');
    }
    this.assertPending(invitation);
    return invitation;
  }

  private hasValidInvitationToken(invitation: OrganizationInvitation): boolean {
    return (
      this.links.hash(this.links.token(invitation.id)) === invitation.tokenHash
    );
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
