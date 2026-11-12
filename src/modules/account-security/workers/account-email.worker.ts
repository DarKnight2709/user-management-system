import type { OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { safeEmailErrorDetails } from '@/core/email/email-error.util.js';
import { jobAttemptLogFields } from '@/core/queues/job-attempt.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import {
  ACCOUNT_EMAIL_QUEUE,
  ACCOUNT_EMAIL_WORKER_CONCURRENCY,
} from '../constants/account-security.constant.js';
import type { AccountEmailJobData } from '../interfaces/account-email-job.interface.js';
import { SecurityTokenEmailDeliveryService } from '../services/security-token-email-delivery.service.js';

@Processor(ACCOUNT_EMAIL_QUEUE, {
  concurrency: ACCOUNT_EMAIL_WORKER_CONCURRENCY,
})
export class AccountEmailWorker extends WorkerHost implements OnModuleDestroy {
  constructor(
    private readonly delivery: SecurityTokenEmailDeliveryService,
    private readonly logging: LoggingService,
  ) {
    super();
  }

  async process(job: Job<AccountEmailJobData>): Promise<void> {
    switch (job.name) {
      case EmailJobNames.SEND_PASSWORD_RESET_EMAIL:
        await this.delivery.deliver('PASSWORD_RESET', job.data);
        break;
      case EmailJobNames.SEND_EMAIL_VERIFICATION:
        await this.delivery.deliver('EMAIL_VERIFICATION', job.data);
        break;
      default:
        throw new UnrecoverableError('Unsupported account email job');
    }
  }

  @OnWorkerEvent('error')
  onError(error: unknown): void {
    this.logging.application({
      event: 'email.worker_error',
      queue: ACCOUNT_EMAIL_QUEUE,
      ...safeEmailErrorDetails(error),
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    this.logging.application({
      event: 'email.job_failed',
      queue: ACCOUNT_EMAIL_QUEUE,
      ...(job ? jobAttemptLogFields(job) : {}),
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
