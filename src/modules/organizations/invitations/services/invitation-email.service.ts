import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '@/core/database/prisma.service.js';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { LoggingService } from '@/modules/logging/logging.service.js';

@Injectable()
export class InvitationEmailService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @InjectQueue(INVITATION_EMAIL_QUEUE)
    private readonly queue: Queue<SendInvitationJobData>,
    private readonly logging: LoggingService,
  ) {
    this.queue.on('error', () => {
      this.logging.application({
        event: 'invitation.queue_unavailable',
        queue: INVITATION_EMAIL_QUEUE,
      });
    });
  }

  async enqueue(invitationId: string, version: number): Promise<boolean> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let stage: 'queue-acknowledgement' | 'database-mark-queued' =
      'queue-acknowledgement';
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
      stage = 'database-mark-queued';
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
      this.logging.application({
        event: 'invitation.enqueue_unavailable',
        invitationId,
        version,
        stage,
        queue: INVITATION_EMAIL_QUEUE,
      });
      return false;
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
