import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { InvitationLinksService } from './invitation-links.service.js';
import { EmailService } from './email.service.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';

@Injectable()
export class InvitationDeliveryService {
  private readonly logger = new Logger(InvitationDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly links: InvitationLinksService,
    private readonly email: EmailService,
  ) {}

  async deliver(job: SendInvitationJobData): Promise<void> {
    this.validateJob(job);
    const { invitationId, version } = job;
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
      if (
        this.links.hash(this.links.token(invitation.id)) !==
        invitation.tokenHash
      ) {
        throw new Error('Invitation token configuration changed');
      }
      await this.email.sendInvitationEmail(
        invitation.email,
        invitation.organization.name,
        this.links.link(invitation.id),
        invitation.expiresAt,
      );
      await this.prisma.organizationInvitation.updateMany({
        where: { id: invitation.id, deliveryVersion: version },
        data: { deliveryStatus: 'SENT', sentAt: new Date() },
      });
    } catch {
      await this.markFailed(job);
      throw new Error('Invitation email delivery failed');
    }
  }

  private validateJob({ invitationId, version }: SendInvitationJobData): void {
    if (
      typeof invitationId !== 'string' ||
      !invitationId.trim() ||
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
    } catch {
      this.logger.warn('Invitation delivery state could not be recorded');
    }
  }
}
