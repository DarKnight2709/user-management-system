import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { INVITATION_EXPIRY_DAYS } from '../constants/invitation.constant.js';
import { CreateInvitationDto } from '../dto/invitation.dto.js';
import type {
  CreateInvitationInput,
  PreviousMembership,
} from '../interfaces/invitation.interface.js';
import { queueInvitationEmail } from '../utils/invitation-email.util.js';
import { InvitationEmailService } from './invitation-email.service.js';
import { InvitationLinksService } from './invitation-links.service.js';
import { InvitationRulesService } from './invitation-rules.service.js';

/** Creates invitations; delivery is queued only after the transaction commits. */
@Injectable()
export class InvitationCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: InvitationRulesService,
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
        this.createInTransaction(manager, {
          actorId,
          organizationId,
          email,
          invitationId: id,
          tokenHash,
        }),
      );
    this.logging.publishCommittedAudit(auditEvent);
    return queueInvitationEmail(this.email, invitation);
  }

  private async createInTransaction(
    manager: Prisma.TransactionClient,
    {
      actorId,
      organizationId,
      email,
      invitationId,
      tokenHash,
    }: CreateInvitationInput,
  ) {
    await this.rules.authorizeActor(manager, actorId, organizationId);
    const outsiderOrPreviousMembership =
      await this.rules.assertInvitableAccount(manager, organizationId, email);
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

  /** Strictly after any earlier removal so older invitations cannot restore access. */
  private getInvitationCreatedAt(previousMembership: PreviousMembership): Date {
    return new Date(
      Math.max(Date.now(), (previousMembership?.deletedAt?.getTime() ?? 0) + 1),
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
}
