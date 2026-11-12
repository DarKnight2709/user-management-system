import { UnrecoverableError, type Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import type { SecurityTokenEmailDeliveryService } from '../services/security-token-email-delivery.service.js';
import { AccountEmailWorker } from '../workers/account-email.worker.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

function setup() {
  const deliver = vi.fn().mockResolvedValue(undefined);
  const application = vi.fn();
  const worker = new AccountEmailWorker(
    { deliver } as unknown as SecurityTokenEmailDeliveryService,
    { application } as unknown as LoggingService,
  );
  return { worker, deliver, application };
}

const job = (name: string, data: unknown = { tokenId: 'id' }) =>
  ({ name, data }) as unknown as Job<{ tokenId: string }>;

describe('AccountEmailWorker', () => {
  describe('process', () => {
    it('hands a password reset job to the delivery service', async () => {
      const { worker, deliver } = setup();

      await worker.process(job('send-password-reset'));

      expect(deliver).toHaveBeenCalledExactlyOnceWith('PASSWORD_RESET', {
        tokenId: 'id',
      });
    });

    it('hands an email verification job to the delivery service', async () => {
      const { worker, deliver } = setup();

      await worker.process(job('send-email-verification'));

      expect(deliver).toHaveBeenCalledExactlyOnceWith('EMAIL_VERIFICATION', {
        tokenId: 'id',
      });
    });

    it('rejects an unknown job without retrying it', async () => {
      const { worker } = setup();

      await expect(
        worker.process(job('send-something-else')),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    });

    it('does not deliver an unknown job', async () => {
      const { worker, deliver } = setup();

      await worker.process(job('send-something-else')).catch(() => undefined);

      expect(deliver).not.toHaveBeenCalled();
    });

    it('does not take over invitation jobs', async () => {
      const { worker, deliver } = setup();

      await worker.process(job('send-invitation')).catch(() => undefined);

      expect(deliver).not.toHaveBeenCalled();
    });
  });

  describe('events', () => {
    it('logs a worker error with a safe code only', () => {
      const { worker, application } = setup();

      worker.onError(
        Object.assign(new Error('private'), { code: 'ECONNRESET' }),
      );

      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'email.worker_error',
        queue: 'account-email',
        code: 'ECONNRESET',
      });
    });

    it('logs a failed attempt with its attempt counts', () => {
      const { worker, application } = setup();

      worker.onFailed({
        attemptsMade: 2,
        opts: { attempts: 3 },
      } as unknown as Job);

      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'email.job_failed',
        queue: 'account-email',
        attempt: 2,
        maxAttempts: 3,
      });
    });

    it('logs a failure even when BullMQ gives no job', () => {
      const { worker, application } = setup();

      worker.onFailed(undefined);

      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'email.job_failed',
        queue: 'account-email',
      });
    });

    it('never logs the job data', () => {
      const { worker, application } = setup();

      worker.onFailed({
        attemptsMade: 1,
        opts: { attempts: 3 },
        data: { tokenId: 'private-token-id' },
      } as unknown as Job);

      expect(JSON.stringify(application.mock.calls)).not.toContain('private');
    });
  });
});
