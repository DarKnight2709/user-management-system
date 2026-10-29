import { type OnModuleDestroy } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError, type Worker } from 'bullmq';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';
import { safeEmailErrorDetails } from '../utils/email-error.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';

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
    const data = job.data as Partial<SendInvitationJobData> | undefined;
    const invitationId =
      typeof data?.invitationId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.invitationId,
      )
        ? data.invitationId
        : undefined;
    const version =
      typeof data?.version === 'number' &&
      Number.isInteger(data.version) &&
      data.version > 0
        ? data.version
        : undefined;
    const attempt =
      Number.isInteger(job.attemptsMade) && job.attemptsMade > 0
        ? job.attemptsMade
        : undefined;
    const maxAttempts =
      Number.isInteger(job.opts.attempts) && job.opts.attempts! > 0
        ? job.opts.attempts
        : undefined;
    this.logging.application({
      event: 'email.job_failed',
      queue: INVITATION_EMAIL_QUEUE,
      ...(invitationId && version ? { invitationId, version } : {}),
      ...(attempt && maxAttempts ? { attempt, maxAttempts } : {}),
    });
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    const data = job.data as Partial<SendInvitationJobData> | undefined;
    if (
      typeof data?.invitationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        data.invitationId,
      ) ||
      !Number.isInteger(data.version) ||
      data.version! < 1
    ) {
      return;
    }
    this.logging.application({
      event: 'email.job_completed',
      queue: INVITATION_EMAIL_QUEUE,
      invitationId: data.invitationId,
      version: data.version!,
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
