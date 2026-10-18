import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/core/database/prisma.service.js';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';

@Injectable()
export class InvitationEmailService {
  private readonly logger = new Logger(InvitationEmailService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(INVITATION_EMAIL_QUEUE)
    private readonly queue: Queue<SendInvitationJobData>,
  ) {
    this.queue.on('error', () =>
      this.logger.warn('Invitation queue connection unavailable'),
    );
  }

  async enqueue(invitationId: string, version: number): Promise<boolean> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const queued = this.queue.add(
        EmailJobNames.SEND_INVITATION_EMAIL,
        { invitationId, version },
        {
          // prevent duplicate jobs creation when resending
          jobId: `${invitationId}-${version}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1_000 },
          removeOnComplete: true,
          removeOnFail: { age: 604_800, count: 1_000 },
        },
      );
      await Promise.race([
        queued,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('Queue acknowledgement deadline exceeded')),
            3_000,
          );
        }),
      ]);
      await this.prisma.organizationInvitation.updateMany({
        where: {
          id: invitationId,
          deliveryVersion: version,
          deliveryStatus: 'NOT_QUEUED',
        },
        data: { deliveryStatus: 'QUEUED' },
      });
      return true;
    } catch {
      this.logger.warn(
        'Invitation email enqueue unavailable; resend or copy link remains available',
      );
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
