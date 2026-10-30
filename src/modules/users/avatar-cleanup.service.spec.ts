import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { S3Service } from '@/core/storage/s3.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { AvatarCleanupService } from './avatar-cleanup.service.js';

const taskId = '123e4567-e89b-42d3-a456-426614174000';

describe('AvatarCleanupService application logging', () => {
  const findMany = vi.fn();
  const updateMany = vi.fn();
  const deleteMany = vi.fn();
  const findFirst = vi.fn();
  const deleteObject = vi.fn();
  const application = vi.fn();

  function createService() {
    const prisma = {
      avatarCleanupTask: { findMany, updateMany, deleteMany },
      user: { findFirst },
    } as unknown as PrismaService;
    return new AvatarCleanupService(
      prisma,
      { delete: deleteObject } as unknown as S3Service,
      { application } as unknown as LoggingService,
    );
  }

  beforeEach(() => vi.clearAllMocks());

  it('records worker failure without forwarding database diagnostics', async () => {
    findMany.mockRejectedValueOnce(
      new Error('private database connection details'),
    );

    await createService().processDue();

    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'avatar.cleanup_worker_failed',
      errorCategory: 'unknown',
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private');
  });

  it('records safe retry metadata without exposing the object key', async () => {
    findMany.mockResolvedValueOnce([
      {
        id: taskId,
        objectKey: 'private-object-key.jpg',
        attempts: 0,
        nextAttemptAt: new Date(),
        leaseToken: null,
        leaseUntil: null,
        createdAt: new Date(),
      },
    ]);
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    findFirst.mockRejectedValueOnce(
      Object.assign(new Error('private storage response'), {
        name: 'ServiceUnavailable',
      }),
    );

    await createService().processDue();

    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'avatar.cleanup_retry_scheduled',
      taskId,
      attempt: 1,
      errorCategory: 'storage_unavailable',
      retryDelayMs: 30_000,
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain(
      'private-object-key',
    );
  });
});
