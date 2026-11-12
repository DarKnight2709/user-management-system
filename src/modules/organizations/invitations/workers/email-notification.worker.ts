import { type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { UnrecoverableError, type Job, type Worker } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';
import { safeEmailErrorDetails } from '@/core/email/email-error.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { jobAttemptLogFields } from '@/core/queues/job-attempt.util.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type JobReference = Pick<SendInvitationJobData, 'invitationId' | 'version'>;

@Processor(INVITATION_EMAIL_QUEUE, { concurrency: 3 })
export class EmailNotificationWorker
  extends WorkerHost
  implements OnModuleDestroy
{
  constructor(
    private readonly delivery: InvitationDeliveryService,
    private readonly logging: LoggingService,
  ) {
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
    this.logging.application({
      event: 'email.worker_error',
      queue: INVITATION_EMAIL_QUEUE,
      ...safeEmailErrorDetails(error),
    });
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined): void {
    if (!job) {
      this.logging.application({
        event: 'email.job_failed',
        queue: INVITATION_EMAIL_QUEUE,
      });
      return;
    }
    const reference = this.parseJobReference(job.data);
    this.logging.application({
      event: 'email.job_failed',
      queue: INVITATION_EMAIL_QUEUE,
      ...this.jobReferenceLogFields(reference),
      ...jobAttemptLogFields(job),
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    const reference = this.parseJobReference(job.data);
    if (!reference) {
      return;
    }
    this.logging.application({
      event: 'email.job_completed',
      queue: INVITATION_EMAIL_QUEUE,
      ...reference,
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

  private parseJobReference(data: unknown): JobReference | undefined {
    if (!this.isRecord(data)) {
      return undefined;
    }

    const { invitationId, version } = data;
    if (
      typeof invitationId !== 'string' ||
      !UUID_PATTERN.test(invitationId) ||
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1
    ) {
      return undefined;
    }

    return { invitationId, version };
  }

  private jobReferenceLogFields(
    reference: JobReference | undefined,
  ): Partial<JobReference> {
    return reference ?? {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
