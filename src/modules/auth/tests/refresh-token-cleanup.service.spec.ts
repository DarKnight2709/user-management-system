import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/core/database/prisma.service.js';
import { Prisma } from '@/generated/prisma/client.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import {
  REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
  REFRESH_TOKEN_CLEANUP_INTERVAL_MS,
  REFRESH_TOKEN_CLEANUP_MAX_BATCHES,
  REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS,
} from '../constants/auth.constant.js';
import { RefreshTokenCleanupService } from '../services/refresh-token-cleanup.service.js';

const NOW = new Date('2026-06-15T12:00:00Z');

const rows = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `token-${index}` }));

function setup() {
  const findMany = vi.fn().mockResolvedValue([]);
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const application = vi.fn();
  const service = new RefreshTokenCleanupService(
    { refreshToken: { findMany, deleteMany } } as unknown as PrismaService,
    { application } as unknown as LoggingService,
  );
  return { service, findMany, deleteMany, application };
}

describe('RefreshTokenCleanupService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('selecting rows', () => {
    it('only considers tokens that expired before the retention cut-off', async () => {
      const { service, findMany } = setup();

      await service.deleteExpired();

      expect(findMany).toHaveBeenCalledWith({
        where: {
          expiresAt: {
            lt: new Date(
              NOW.getTime() - REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS,
            ),
          },
        },
        select: { id: true },
        take: REFRESH_TOKEN_CLEANUP_BATCH_SIZE,
      });
    });

    it('deletes only the rows it found, re-checking expiry', async () => {
      const { service, findMany, deleteMany } = setup();
      findMany.mockResolvedValueOnce(rows(2));
      deleteMany.mockResolvedValueOnce({ count: 2 });

      await service.deleteExpired();

      expect(deleteMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['token-0', 'token-1'] },
          expiresAt: {
            lt: new Date(
              NOW.getTime() - REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS,
            ),
          },
        },
      });
    });

    it('does not delete anything when nothing has expired', async () => {
      const { service, deleteMany } = setup();

      await service.deleteExpired();

      expect(deleteMany).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    it('stops after a batch smaller than the batch size', async () => {
      const { service, findMany, deleteMany } = setup();
      findMany.mockResolvedValueOnce(rows(3));
      deleteMany.mockResolvedValueOnce({ count: 3 });

      await service.deleteExpired();

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('keeps going while batches are full', async () => {
      const { service, findMany, deleteMany } = setup();
      findMany
        .mockResolvedValueOnce(rows(REFRESH_TOKEN_CLEANUP_BATCH_SIZE))
        .mockResolvedValueOnce(rows(REFRESH_TOKEN_CLEANUP_BATCH_SIZE))
        .mockResolvedValueOnce(rows(5));
      deleteMany
        .mockResolvedValueOnce({ count: REFRESH_TOKEN_CLEANUP_BATCH_SIZE })
        .mockResolvedValueOnce({ count: REFRESH_TOKEN_CLEANUP_BATCH_SIZE })
        .mockResolvedValueOnce({ count: 5 });

      await service.deleteExpired();

      expect(findMany).toHaveBeenCalledTimes(3);
    });

    it('stops at the batch limit of one run', async () => {
      const { service, findMany, deleteMany } = setup();
      findMany.mockResolvedValue(rows(REFRESH_TOKEN_CLEANUP_BATCH_SIZE));
      deleteMany.mockResolvedValue({ count: REFRESH_TOKEN_CLEANUP_BATCH_SIZE });

      await service.deleteExpired();

      expect(findMany).toHaveBeenCalledTimes(REFRESH_TOKEN_CLEANUP_MAX_BATCHES);
    });
  });

  describe('failures', () => {
    it('logs a fixed event instead of throwing', async () => {
      const { service, findMany, application } = setup();
      findMany.mockRejectedValueOnce(new Error('private connection details'));

      await expect(service.deleteExpired()).resolves.toBeUndefined();

      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'auth.refresh_token_cleanup_failed',
        errorCategory: 'unknown',
      });
    });

    it('never forwards the error message', async () => {
      const { service, findMany, application } = setup();
      findMany.mockRejectedValueOnce(new Error('private connection details'));

      await service.deleteExpired();

      expect(JSON.stringify(application.mock.calls)).not.toContain('private');
    });

    it('labels database errors as such', async () => {
      const { service, findMany, application } = setup();
      findMany.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('private', {
          code: 'P2021',
          clientVersion: 'fixture',
        }),
      );

      await service.deleteExpired();

      expect(application).toHaveBeenCalledWith({
        event: 'auth.refresh_token_cleanup_failed',
        errorCategory: 'database',
      });
    });

    it('runs again after a failure', async () => {
      const { service, findMany } = setup();
      findMany.mockRejectedValueOnce(new Error('first run fails'));

      await service.deleteExpired();
      await service.deleteExpired();

      expect(findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe('overlapping runs', () => {
    it('ignores a run requested while another is in progress', async () => {
      const { service, findMany } = setup();
      let finishFirstRun: (value: unknown[]) => void = () => undefined;
      findMany.mockReturnValueOnce(
        new Promise((resolve) => {
          finishFirstRun = resolve;
        }),
      );

      const firstRun = service.deleteExpired();
      await service.deleteExpired();
      finishFirstRun([]);
      await firstRun;

      expect(findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('lifecycle', () => {
    it('runs once at startup', () => {
      const { service, findMany } = setup();

      service.onModuleInit();

      expect(findMany).toHaveBeenCalledTimes(1);
    });

    it('runs again every interval', async () => {
      const { service, findMany } = setup();
      service.onModuleInit();

      await vi.advanceTimersByTimeAsync(REFRESH_TOKEN_CLEANUP_INTERVAL_MS);

      expect(findMany).toHaveBeenCalledTimes(2);
    });

    it('stops running after shutdown', async () => {
      const { service, findMany } = setup();
      service.onModuleInit();
      await service.onModuleDestroy();
      findMany.mockClear();

      await vi.advanceTimersByTimeAsync(REFRESH_TOKEN_CLEANUP_INTERVAL_MS * 2);
      await service.deleteExpired();

      expect(findMany).not.toHaveBeenCalled();
    });

    it('waits for the run in progress before finishing shutdown', async () => {
      const { service, findMany } = setup();
      let finishRun: (value: unknown[]) => void = () => undefined;
      findMany.mockReturnValueOnce(
        new Promise((resolve) => {
          finishRun = resolve;
        }),
      );
      void service.deleteExpired();
      let shutDown = false;

      const shutdown = service.onModuleDestroy().then(() => {
        shutDown = true;
      });
      await Promise.resolve();
      const finishedBeforeRun = shutDown;
      finishRun([]);
      await shutdown;

      expect(finishedBeforeRun).toBe(false);
    });
  });
});
