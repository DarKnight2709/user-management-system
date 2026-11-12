import type { Job } from 'bullmq';

/** Attempt numbers for a failed-job log; empty when BullMQ gave no usable counts. */
export function jobAttemptLogFields(job: Job): {
  attempt?: number;
  maxAttempts?: number;
} {
  const attempt =
    Number.isInteger(job.attemptsMade) && job.attemptsMade > 0
      ? job.attemptsMade
      : undefined;
  const maxAttempts =
    typeof job.opts.attempts === 'number' &&
    Number.isInteger(job.opts.attempts) &&
    job.opts.attempts > 0
      ? job.opts.attempts
      : undefined;

  return attempt && maxAttempts ? { attempt, maxAttempts } : {};
}
