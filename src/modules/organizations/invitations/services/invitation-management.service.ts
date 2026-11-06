import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type {
  OrganizationInvitation,
  Prisma,
} from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  INVITATION_LIST_SELECT,
  INVITATION_STATUS_FILTERS,
  MAX_RESEND_COUNT,
  RESEND_COOLDOWN_MS,
} from '../constants/invitation.constant.js';
import { ListInvitationsQueryDto } from '../dto/list-invitations-query.dto.js';
import type {
  InvitationActionInput,
  InvitationListRecord,
  ListInvitationsInput,
} from '../interfaces/invitation.interface.js';
import { queueInvitationEmail } from '../utils/invitation-email.util.js';
import { InvitationEmailService } from './invitation-email.service.js';
import { InvitationRulesService } from './invitation-rules.service.js';

/** Lists, resends, copies and revokes existing invitations. */
@Injectable()
export class InvitationManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: InvitationRulesService,
    private readonly email: InvitationEmailService,
    private readonly logging: LoggingService,
  ) {}

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
    return queueInvitationEmail(this.email, invitation);
  }

  /** Reconstructs the link for an authorized caller; it never sends email. */
  async copyLink(
    actorId: string,
    organizationId: string,
    invitationId: string,
  ) {
    return this.prisma.serializableTransaction((manager) =>
      this.copyLinkInTransaction(manager, {
        actorId,
        organizationId,
        invitationId,
      }),
    );
  }

  async revoke(actorId: string, organizationId: string, invitationId: string) {
    const auditEvent = await this.prisma.serializableTransaction((manager) =>
      this.revokeInTransaction(manager, {
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
      this.listInTransaction(manager, {
        actorId,
        organizationId,
        page,
        limit,
        email,
        status,
      }),
    );
  }

  private async requestResendInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, organizationId, invitationId }: InvitationActionInput,
  ) {
    await this.rules.authorizeActor(manager, actorId, organizationId);
    const invitation = await this.rules.findInvitation(
      manager,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    this.rules.assertPending(invitation);
    this.rules.createLink(invitation);
    const previousMembership = await this.rules.assertInvitableAccount(
      manager,
      organizationId,
      invitation.email,
    );
    this.rules.assertCreatedAfterRemoval(invitation, previousMembership);
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

  private async revokeInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, organizationId, invitationId }: InvitationActionInput,
  ) {
    await this.rules.authorizeActor(manager, actorId, organizationId);
    const invitation = await this.rules.findInvitation(
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

  private async copyLinkInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, organizationId, invitationId }: InvitationActionInput,
  ) {
    await this.rules.authorizeActor(manager, actorId, organizationId);
    const invitation = await this.rules.findInvitation(
      manager,
      organizationId,
      invitationId,
    );
    if (!invitation) throw new NotFoundException('Invitation not found');
    this.rules.assertPending(invitation);
    const previousMembership = await this.rules.assertInvitableAccount(
      manager,
      organizationId,
      invitation.email,
    );
    this.rules.assertCreatedAfterRemoval(invitation, previousMembership);
    return {
      id: invitation.id,
      inviteLink: this.rules.createLink(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  private async listInTransaction(
    manager: Prisma.TransactionClient,
    input: ListInvitationsInput,
  ) {
    const { actorId, organizationId, page, limit } = input;
    await this.rules.authorizeActor(manager, actorId, organizationId);
    const now = new Date();
    const where = this.buildListFilter(input, now);
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
      items: records.map((record) => this.mapListRecord(record, now)),
      total,
      page,
      limit,
    };
  }

  private buildListFilter(
    { organizationId, email, status }: ListInvitationsInput,
    now: Date,
  ): Prisma.OrganizationInvitationWhereInput {
    return {
      organizationId,
      ...(email && {
        email: { contains: email, mode: 'insensitive' },
      }),
      ...this.buildStatusFilter(status, now),
    };
  }

  private buildStatusFilter(
    status: ListInvitationsInput['status'],
    now: Date,
  ): Prisma.OrganizationInvitationWhereInput {
    if (!status) return {};
    return INVITATION_STATUS_FILTERS[status]?.(now) ?? { status };
  }

  /** A pending invitation past its expiry is reported as EXPIRED. */
  private mapListRecord(record: InvitationListRecord, now: Date) {
    return {
      ...record,
      role: 'MEMBER' as const,
      status:
        record.status === 'PENDING' && record.expiresAt <= now
          ? ('EXPIRED' as const)
          : record.status,
    };
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
}
