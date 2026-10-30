import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { InvitationLinksService } from './invitation-links.service.js';
import { EmailService } from './email.service.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { safeEmailErrorDetails } from '../utils/email-error.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { InvitationDeliveryStage } from '@/modules/logging/types/application-event.types.js';

@Injectable()
export class InvitationDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly links: InvitationLinksService,
    private readonly email: EmailService,
    private readonly logging: LoggingService,
  ) {}

  async deliver(job: SendInvitationJobData): Promise<void> {
    this.validateJob(job);
    const { invitationId, version } = job;
    let stage: InvitationDeliveryStage = 'database-read';
    try {
      const invitation = await this.prisma.organizationInvitation.findUnique({
        where: { id: invitationId },
        include: {
          organization: {
            select: { name: true, isActive: true, deletedAt: true },
          },
        },
      });
      if (
        !invitation ||
        invitation.status !== 'PENDING' ||
        invitation.expiresAt <= new Date() ||
        invitation.deliveryVersion !== version ||
        invitation.deliveryStatus === 'SENT' ||
        !invitation.organization.isActive ||
        invitation.organization.deletedAt
      ) {
        return;
      }
      stage = 'link-configuration';
      if (
        this.links.hash(this.links.token(invitation.id)) !==
        invitation.tokenHash
      ) {
        throw new Error('Invitation token configuration changed');
      }
      const inviteLink = this.links.link(invitation.id);
      stage = 'smtp-send';
      await this.email.sendInvitationEmail(
        invitation.email,
        invitation.organization.name,
        inviteLink,
        invitation.expiresAt,
      );
      stage = 'database-record-sent';
      await this.prisma.organizationInvitation.updateMany({
        where: { id: invitation.id, deliveryVersion: version },
        data: { deliveryStatus: 'SENT', sentAt: new Date() },
      });
    } catch (error) {
      this.logging.application({
        event: 'invitation.delivery_failed',
        invitationId,
        version,
        stage,
        ...safeEmailErrorDetails(error),
      });
      await this.markFailed(job);
      throw new Error('Invitation email delivery failed');
    }
  }

  private validateJob({ invitationId, version }: SendInvitationJobData): void {
    if (
      typeof invitationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        invitationId,
      ) ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      throw new Error('Invalid invitation delivery job');
    }
  }

  private async markFailed({ invitationId, version }: SendInvitationJobData) {
    try {
      await this.prisma.organizationInvitation.updateMany({
        where: {
          id: invitationId,
          deliveryVersion: version,
          deliveryStatus: { not: 'SENT' },
        },
        data: { deliveryStatus: 'FAILED' },
      });
    } catch (error) {
      this.logging.application({
        event: 'invitation.failure_record_failed',
        invitationId,
        version,
        stage: 'database-record-failed',
        ...safeEmailErrorDetails(error),
      });
    }
  }
}
