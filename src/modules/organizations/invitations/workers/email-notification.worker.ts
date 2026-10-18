import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError, type Worker } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';

@Processor(INVITATION_EMAIL_QUEUE, { concurrency: 3 })
export class EmailNotificationWorker
  extends WorkerHost
  implements OnModuleDestroy
{
  private readonly logger = new Logger(EmailNotificationWorker.name);

  constructor(private readonly delivery: InvitationDeliveryService) {
    super();
  }

  async process(job: Job<SendInvitationJobData>): Promise<void> {
    switch (job.name) {
      case EmailJobNames.SEND_INVITATION_EMAIL:
        await this.delivery.deliver(job.data);
        break;
      default:
        throw new UnrecoverableError('Unsupported email job');
    }
  }

  @OnWorkerEvent('error')
  onError(): void {
    this.logger.warn(`Worker (${INVITATION_EMAIL_QUEUE}) encountered an error`);
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    if (!job) {
      this.logger.warn(
        `Worker (${INVITATION_EMAIL_QUEUE}) reported a failed job`,
      );
      return;
    }
    this.logger.warn(`Job ${job.id} (${job.name}) attempt failed`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`Job ${job.id} (${job.name}) completed`);
  }

  async onModuleDestroy(): Promise<void> {
    let worker: Worker;
    try {
      worker = this.worker;
    } catch {
      return;
    }
    await worker.close();
  }
}
