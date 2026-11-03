import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '@/core/database/prisma.service.js';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { LoggingService } from '@/modules/logging/logging.service.js';

const QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS = 3_000;
const MAX_JOB_ATTEMPTS = 3;
const RETRY_BACKOFF_DELAY_MS = 1_000;
const FAILED_JOB_RETENTION_SECONDS = 604_800;
const MAX_RETAINED_FAILED_JOBS = 1_000;
type EnqueueStage = 'queue-acknowledgement' | 'database-mark-queued';

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
    let stage: EnqueueStage = 'queue-acknowledgement';
    try {
      const queueAcknowledgement = this.addInvitationJob(
        invitationId,
        version,
      );
      const acknowledgementTimeout =
        this.createQueueAcknowledgementTimeout();
      deadline = acknowledgementTimeout.timer;
      await Promise.race([
        queueAcknowledgement,
        acknowledgementTimeout.promise,
      ]);
      stage = 'database-mark-queued';
      await this.markQueued(invitationId, version);
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

  private addInvitationJob(invitationId: string, version: number) {
    return this.queue.add(
      EmailJobNames.SEND_INVITATION_EMAIL,
      { invitationId, version },
      {
        jobId: `${invitationId}-${version}`,
        attempts: MAX_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: RETRY_BACKOFF_DELAY_MS },
        removeOnComplete: true,
        removeOnFail: {
          age: FAILED_JOB_RETENTION_SECONDS,
          count: MAX_RETAINED_FAILED_JOBS,
        },
      },
    );
  }

  private createQueueAcknowledgementTimeout(): {
    promise: Promise<never>;
    timer: ReturnType<typeof setTimeout>;
  } {
    let timer: ReturnType<typeof setTimeout>;
    const promise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Queue acknowledgement deadline exceeded')),
        QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS,
      );
    });
    return { promise, timer: timer! };
  }

  private async markQueued(
    invitationId: string,
    version: number,
  ): Promise<void> {
    await this.prisma.organizationInvitation.updateMany({
      where: {
        id: invitationId,
        deliveryVersion: version,
        deliveryStatus: 'NOT_QUEUED',
      },
      data: { deliveryStatus: 'QUEUED' },
    });
  }
}
