import type { Queue } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { AccountEmailQueueService } from '../services/account-email-queue.service.js';

const ROW_ID = '123e4567-e89b-42d3-a456-426614174001';

function setup() {
  const add = vi.fn().mockResolvedValue({});
  const listeners = new Map<string, () => void>();
  const queue = {
    add,
    on: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
  };
  const application = vi.fn();
  const service = new AccountEmailQueueService(
    queue as unknown as Queue,
    { application } as unknown as LoggingService,
  );
  return { service, add, application, listeners };
}

describe('AccountEmailQueueService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enqueuePasswordReset', () => {
    it('adds a password reset job that carries only the token id', async () => {
      const { service, add } = setup();

      await service.enqueuePasswordReset(ROW_ID);

      expect(add).toHaveBeenCalledWith(
        'send-password-reset',
        { tokenId: ROW_ID },
        expect.any(Object),
      );
    });

    it('uses the token id as the job id so one token is never queued twice', async () => {
      const { service, add } = setup();

      await service.enqueuePasswordReset(ROW_ID);

      expect(add.mock.calls[0][2]).toMatchObject({ jobId: ROW_ID });
    });

    it('retries a failed job with backoff', async () => {
      const { service, add } = setup();

      await service.enqueuePasswordReset(ROW_ID);

      expect(add.mock.calls[0][2]).toMatchObject({
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
      });
    });

    it('does not keep completed jobs', async () => {
      const { service, add } = setup();

      await service.enqueuePasswordReset(ROW_ID);

      expect(add.mock.calls[0][2]).toMatchObject({ removeOnComplete: true });
    });

    it('bounds how long failed jobs are kept', async () => {
      const { service, add } = setup();

      await service.enqueuePasswordReset(ROW_ID);

      expect(add.mock.calls[0][2].removeOnFail).toEqual({
        age: 604_800,
        count: 1_000,
      });
    });

    it('reports success when the queue accepts the job', async () => {
      const { service } = setup();

      await expect(service.enqueuePasswordReset(ROW_ID)).resolves.toBe(true);
    });

    describe('when the queue refuses the job', () => {
      it('reports failure instead of throwing', async () => {
        const { service, add } = setup();
        add.mockRejectedValue(new Error('private redis details'));

        await expect(service.enqueuePasswordReset(ROW_ID)).resolves.toBe(false);
      });

      it('logs a fixed event without the error', async () => {
        const { service, add, application } = setup();
        add.mockRejectedValue(new Error('private redis details'));

        await service.enqueuePasswordReset(ROW_ID);

        expect(application).toHaveBeenCalledExactlyOnceWith({
          event: 'account_email.enqueue_unavailable',
          queue: 'account-email',
          kind: 'password-reset',
        });
      });
    });

    describe('when the queue does not answer', () => {
      it('gives up after the acknowledgement deadline', async () => {
        const { service, add, application } = setup();
        add.mockReturnValue(new Promise(() => undefined));

        const result = service.enqueuePasswordReset(ROW_ID);
        await vi.advanceTimersByTimeAsync(3_000);

        await expect(result).resolves.toBe(false);
        expect(application).toHaveBeenCalledOnce();
      });

      it('does not give up earlier', async () => {
        const { service, add } = setup();
        add.mockReturnValue(new Promise(() => undefined));
        let settled = false;

        void service.enqueuePasswordReset(ROW_ID).then(() => (settled = true));
        await vi.advanceTimersByTimeAsync(2_999);

        expect(settled).toBe(false);
      });
    });
  });

  describe('queue errors', () => {
    it('are logged as a fixed event', () => {
      const { listeners, application } = setup();

      listeners.get('error')?.();

      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'account_email.queue_unavailable',
        queue: 'account-email',
      });
    });
  });
});
