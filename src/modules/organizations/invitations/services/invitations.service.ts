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
import { ListOrganizationsQueryDto } from '../../dto/list-organizations-query.dto.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

const currentRequestId = () =>
  requestContext.getStore()?.requestId ?? randomUUID();

const summary = {
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

type PreviousMembership = {
  id: string;
  status: string;
  deletedAt: Date | null;
} | null;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly links: InvitationLinksService,
    private readonly email: InvitationEmailService,
    private readonly logging: LoggingService,
  ) {}

  private async authorize(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ) {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
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

  private async assertInvitable(
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
    const membership = account
      ? await manager.organizationMember.findUnique({
          where: {
            organizationId_userId: { organizationId, userId: account.id },
          },
          select: { id: true, status: true, deletedAt: true },
        })
      : null;
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

  private assertFreshInvitation(
    invitation: OrganizationInvitation,
    previous: PreviousMembership,
  ): void {
    if (previous?.deletedAt && invitation.createdAt <= previous.deletedAt) {
      throw new ConflictException(
        'Create a new invitation after member removal',
      );
    }
  }

  private pending(invitation: OrganizationInvitation) {
    if (invitation.status !== 'PENDING' || invitation.expiresAt <= new Date()) {
      throw new ConflictException(
        'Invitation is no longer pending or has expired',
      );
    }
  }

  private link(invitation: OrganizationInvitation) {
    // this checking whether the secret env has changed
    if (
      this.links.hash(this.links.token(invitation.id)) !== invitation.tokenHash
    ) {
      throw new ServiceUnavailableException(
        'Invitation token configuration changed',
      );
    }
    return this.links.link(invitation.id);
  }

  private async result(invitation: OrganizationInvitation) {
    const emailQueued = await this.email.enqueue(
      invitation.id,
      invitation.deliveryVersion,
    );
    return {
      emailQueued,
    };
  }

  async create(
    actorId: string,
    organizationId: string,
    dto: CreateInvitationDto,
  ) {
    const email = dto.email.trim().toLowerCase();
    const id = randomUUID();
    const tokenHash = this.links.hash(this.links.token(id));
    const { invitation, auditEvent } =
      await this.prisma.serializableTransaction(async (manager) => {
        await this.authorize(manager, actorId, organizationId);
        const previous = await this.assertInvitable(
          manager,
          organizationId,
          email,
        );
        // A new invitation must be later than the removal, even within the same millisecond.
        const now = new Date(
          Math.max(Date.now(), (previous?.deletedAt?.getTime() ?? 0) + 1),
        );
        let revokedStaleInvitationCount = 0;
        if (previous?.deletedAt) {
          const revoked = await manager.organizationInvitation.updateMany({
            where: {
              organizationId,
              email,
              status: 'PENDING',
              createdAt: { lte: previous.deletedAt },
            },
            data: { status: 'REVOKED', revokedAt: now },
          });
          revokedStaleInvitationCount = revoked.count;
        }
        const expired = await manager.organizationInvitation.updateMany({
          where: {
            organizationId,
            email,
            status: 'PENDING',
            expiresAt: { lte: now },
          },
          data: { status: 'EXPIRED' },
        });
        const existing = await manager.organizationInvitation.findFirst({
          where: { organizationId, email, status: 'PENDING' },
          select: { id: true },
        });
        if (existing)
          throw new ConflictException(
            'A pending invitation already exists; use resend or copy link',
          );
        const invitation = await manager.organizationInvitation.create({
          data: {
            id,
            organizationId,
            email,
            tokenHash,
            createdAt: now,
            invitedById: actorId,
            expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
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
              expiredInvitationCount: expired.count,
              revokedStaleInvitationCount,
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return { invitation, auditEvent };
      });
    this.logging.publishCommittedAudit(auditEvent);
    return await this.result(invitation);
  }

  async resend(actorId: string, organizationId: string, invitationId: string) {
    const { invitation, auditEvent } =
      await this.prisma.serializableTransaction(async (manager) => {
        await this.authorize(manager, actorId, organizationId);
        const invite = await manager.organizationInvitation.findFirst({
          where: { id: invitationId, organizationId },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        this.pending(invite);
        this.link(invite);
        const previous = await this.assertInvitable(
          manager,
          organizationId,
          invite.email,
        );
        this.assertFreshInvitation(invite, previous);
        this.assertResendAllowed(invite);

        const invitation = await manager.organizationInvitation.update({
          where: { id: invite.id },
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
            target: { type: 'ORGANIZATION_INVITATION', id: invite.id },
            organizationId,
            payload: {
              deliveryVersion: invitation.deliveryVersion,
              resendCount: invitation.resendCount,
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return { invitation, auditEvent };
      });
    this.logging.publishCommittedAudit(auditEvent);
    return this.result(invitation);
  }

  private assertResendAllowed(invitation: OrganizationInvitation): void {
    const cooldownMs = 60_000;
    const elapsedMs = Date.now() - invitation.lastRequestedAt.getTime();
    const remainingMs = cooldownMs - elapsedMs;

    if (remainingMs > 0) {
      throw new HttpException(
        {
          message: 'Wait before resending',
          retryAfterSeconds: Math.ceil(remainingMs / 1_000),
        },
        429,
      );
    }

    if (invitation.resendCount >= 5) {
      throw new HttpException(
        'Invitation resend limit reached; copy link remains available',
        429,
      );
    }
  }

  async copyLink(
    actorId: string,
    organizationId: string,
    invitationId: string,
  ) {
    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId);
      const invite = await manager.organizationInvitation.findFirst({
        where: { id: invitationId, organizationId },
      });
      if (!invite) throw new NotFoundException('Invitation not found');
      this.pending(invite);
      const previous = await this.assertInvitable(
        manager,
        organizationId,
        invite.email,
      );
      this.assertFreshInvitation(invite, previous);
      return {
        id: invite.id,
        inviteLink: this.link(invite),
        expiresAt: invite.expiresAt,
      };
    });
  }

  async revoke(actorId: string, organizationId: string, invitationId: string) {
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.authorize(manager, actorId, organizationId);
        const invite = await manager.organizationInvitation.findFirst({
          where: { id: invitationId, organizationId },
        });
        if (!invite) throw new NotFoundException('Invitation not found');
        if (invite.status === 'REVOKED') return null;
        if (invite.status === 'ACCEPTED')
          throw new ConflictException('Accepted invitations cannot be revoked');
        await manager.organizationInvitation.update({
          where: { id: invite.id },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
        return this.logging.audit(
          {
            action: 'organization.invitation.revoked',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION_INVITATION', id: invite.id },
            organizationId,
            payload: { deliveryVersion: invite.deliveryVersion },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
      },
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async list(
    actorId: string,
    organizationId: string,
    { page = 1, limit = 20 }: Partial<ListOrganizationsQueryDto>,
  ) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(manager, actorId, organizationId);
      const where = { organizationId };
      const [records, total] = await Promise.all([
        manager.organizationInvitation.findMany({
          where,
          select: summary,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        manager.organizationInvitation.count({ where }),
      ]);
      const items = records.map((record) => ({
        ...record,
        role: 'MEMBER',
        status:
          record.status === 'PENDING' && record.expiresAt <= new Date()
            ? 'EXPIRED'
            : record.status,
      }));
      return { items, total, page, limit };
    });
  }

  async accept(actorId: string, token: string) {
    const { result, auditEvent } = await this.prisma.serializableTransaction(
      async (manager) => {
        const user = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true, email: true },
        });
        if (!user) throw new UnauthorizedException('Authentication required');

        const invitation = await manager.organizationInvitation.findUnique({
          where: { tokenHash: this.links.hash(token) },
        });
        if (!invitation) throw new BadRequestException('Invalid invitation');
        if (
          this.links.hash(this.links.token(invitation.id)) !==
          invitation.tokenHash
        ) {
          throw new BadRequestException('Invalid invitation');
        }
        this.pending(invitation);

        if (user.email.trim().toLowerCase() !== invitation.email)
          throw new ForbiddenException(
            'Sign in with the invited email address',
          );
        const organization = await manager.organization.findUnique({
          where: {
            id: invitation.organizationId,
            deletedAt: null,
            isActive: true,
          },
          select: { id: true },
        });
        if (!organization)
          throw new ConflictException('Organization is unavailable');
        const previous = await this.assertInvitable(
          manager,
          organization.id,
          invitation.email,
        );
        this.assertFreshInvitation(invitation, previous);
        const role = await manager.role.findFirst({
          where: {
            organizationId: organization.id,
            name: 'MEMBER',
            isSystem: false,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!role)
          throw new ServiceUnavailableException(
            'Organization MEMBER role is unavailable',
          );

        const previousRoleIds = previous?.deletedAt
          ? (
              await manager.memberRole.findMany({
                where: {
                  organizationMemberId: previous.id,
                  deletedAt: null,
                },
                select: { roleId: true },
                orderBy: { roleId: 'asc' },
              })
            ).map(({ roleId }) => roleId)
          : [];

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
          organization.id,
          user.id,
          role.id,
          previous,
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
              membershipReactivated: Boolean(previous?.deletedAt),
              previousRoleIds,
              memberRoleId: role.id,
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return {
          result: { organizationId: organization.id, membershipId: member.id },
          auditEvent,
        };
      },
    );
    this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  private async joinAsMember(
    manager: Prisma.TransactionClient,
    organizationId: string,
    userId: string,
    roleId: string,
    previous: PreviousMembership,
  ) {
    if (!previous) {
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

    // Retained historical roles must never reactivate when membership is restored.
    await manager.memberRole.updateMany({
      where: { organizationMemberId: previous.id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await manager.memberRole.upsert({
      where: {
        organizationMemberId_roleId: {
          organizationMemberId: previous.id,
          roleId,
        },
      },
      create: { organizationMemberId: previous.id, roleId },
      update: { deletedAt: null },
    });
    return manager.organizationMember.update({
      where: {
        id: previous.id,
        organizationId,
        userId,
        status: 'ACTIVE',
        deletedAt: previous.deletedAt,
      },
      data: { status: 'ACTIVE', deletedAt: null },
      select: { id: true },
    });
  }
}
