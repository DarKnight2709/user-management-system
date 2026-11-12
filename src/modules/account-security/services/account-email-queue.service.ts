import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { withDeadline } from '@/common/utils/deadline.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type { AccountEmailKind } from '@/modules/logging/types/application-event.types.js';
import { ACCOUNT_EMAIL_QUEUE } from '../constants/account-security.constant.js';
import type { AccountEmailJobData } from '../interfaces/account-email-job.interface.js';

const QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS = 3_000;
const MAX_JOB_ATTEMPTS = 3;
const RETRY_BACKOFF_DELAY_MS = 1_000;
const FAILED_JOB_RETENTION_SECONDS = 604_800;
const MAX_RETAINED_FAILED_JOBS = 1_000;

const JOB_NAMES: Record<AccountEmailKind, EmailJobNames> = {
  'password-reset': EmailJobNames.SEND_PASSWORD_RESET_EMAIL,
  'email-verification': EmailJobNames.SEND_EMAIL_VERIFICATION,
};

/** Producer for account emails. Call it after the database transaction commits. */
@Injectable()
export class AccountEmailQueueService {
  constructor(
    @InjectQueue(ACCOUNT_EMAIL_QUEUE)
    private readonly queue: Queue<AccountEmailJobData>,
    private readonly logging: LoggingService,
  ) {
    // Without a listener a queue error would be thrown as an unhandled event.
    this.queue.on('error', () => {
      this.logging.application({
        event: 'account_email.queue_unavailable',
        queue: ACCOUNT_EMAIL_QUEUE,
      });
    });
  }

  /** True when the queue accepted the job. A failure never reaches the caller. */
  async enqueue(kind: AccountEmailKind, tokenId: string): Promise<boolean> {
    try {
      await withDeadline(
        this.queue.add(
          JOB_NAMES[kind],
          { tokenId },
          {
            jobId: tokenId,
            attempts: MAX_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: RETRY_BACKOFF_DELAY_MS },
            removeOnComplete: true,
            removeOnFail: {
              age: FAILED_JOB_RETENTION_SECONDS,
              count: MAX_RETAINED_FAILED_JOBS,
            },
          },
        ),
        QUEUE_ACKNOWLEDGEMENT_TIMEOUT_MS,
        'Queue acknowledgement deadline exceeded',
      );
      return true;
    } catch {
      this.logging.application({
        event: 'account_email.enqueue_unavailable',
        queue: ACCOUNT_EMAIL_QUEUE,
        kind,
      });
      return false;
    }
  }
}
