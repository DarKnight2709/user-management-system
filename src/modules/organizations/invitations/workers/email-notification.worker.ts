import { Logger, type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError, type Worker } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';
import { safeEmailErrorDetails } from '../utils/email-error.util.js';

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
  onError(error: unknown): void {
    this.logger.warn({
      message: 'Email worker encountered an error',
      event: 'email.worker_error',
      queue: INVITATION_EMAIL_QUEUE,
      ...safeEmailErrorDetails(error),
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    if (!job) {
      this.logger.warn({
        message: 'Email worker reported a failed job',
        event: 'email.job_failed',
        queue: INVITATION_EMAIL_QUEUE,
      });
      return;
    }
    this.logger.warn({
      message: 'Email job attempt failed',
      event: 'email.job_failed',
      queue: INVITATION_EMAIL_QUEUE,
      jobId: job.id,
      jobName: job.name,
      attempt: job.attemptsMade,
      maxAttempts: job.opts.attempts ?? 1,
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log({
      message: 'Email job completed',
      event: 'email.job_completed',
      queue: INVITATION_EMAIL_QUEUE,
      jobId: job.id,
      jobName: job.name,
    });
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
