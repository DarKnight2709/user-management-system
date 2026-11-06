import { describe, expect, it, vi } from 'vitest';
import { S3Service } from '@/core/storage/s3.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { AvatarCleanupService } from '../avatar-cleanup.service.js';
import { UserAvatarService } from '../user-avatar.service.js';
import { UsersService } from '../users.service.js';

const userId = '323e4567-e89b-42d3-a456-426614174000';
const file = { buffer: Buffer.from('jpeg') } as Express.Multer.File;

function setup() {
  const manager = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ avatarKey: null }),
      update: vi.fn().mockResolvedValue({}),
    },
    avatarCleanupTask: {
      upsert: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = Object.assign(createPrismaStub(manager), {
    avatarCleanupTask: { create: vi.fn().mockResolvedValue({}) },
  });
  const s3 = {
    upload: vi.fn().mockResolvedValue(undefined),
    getPublicUrl: vi.fn((key: string) => `https://cdn.test/${key}`),
  };
  const cleanup = { processDue: vi.fn().mockResolvedValue(undefined) };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const users = { findOne: vi.fn().mockResolvedValue({ id: userId }) };
  const service = new UserAvatarService(
    prisma,
    s3 as unknown as S3Service,
    cleanup as unknown as AvatarCleanupService,
    logging as unknown as LoggingService,
    users as unknown as UsersService,
  );
  return { service, manager, prisma, s3, cleanup, logging, users, auditEvent };
}

describe('UserAvatarService.upload', () => {
  it('rejects a missing file before touching storage', async () => {
    const { service, s3, prisma } = setup();

    await expect(
      service.upload(userId, undefined as unknown as Express.Multer.File),
    ).rejects.toMatchObject({ status: 400 });
    expect(s3.upload).not.toHaveBeenCalled();
    expect(prisma.avatarCleanupTask.create).not.toHaveBeenCalled();
  });

  it('fails for inactive users before recording recovery work', async () => {
    const { service, users, prisma, s3 } = setup();
    users.findOne.mockRejectedValue(
      Object.assign(new Error('User not Found'), { status: 404 }),
    );

    await expect(service.upload(userId, file)).rejects.toMatchObject({
      status: 404,
    });
    expect(prisma.avatarCleanupTask.create).not.toHaveBeenCalled();
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('records a delayed recovery task before uploading', async () => {
    const { service, prisma, s3 } = setup();
    const order: string[] = [];
    prisma.avatarCleanupTask.create.mockImplementation(() => {
      order.push('task');
      return Promise.resolve({});
    });
    s3.upload.mockImplementation(() => {
      order.push('upload');
      return Promise.resolve();
    });

    const before = Date.now();
    const { key } = await service.upload(userId, file);

    expect(order).toEqual(['task', 'upload']);
    const { data } = prisma.avatarCleanupTask.create.mock.calls[0][0] as {
      data: { objectKey: string; nextAttemptAt: Date };
    };
    expect(data.objectKey).toBe(key);
    expect(data.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + 3_600_000,
    );
    expect(s3.upload).toHaveBeenCalledWith(key, file.buffer, 'image/jpeg');
  });

  it('stores the new key, cancels its recovery task and audits ADDED', async () => {
    const { service, manager, logging, auditEvent, cleanup } = setup();

    const { key, avatarUrl } = await service.upload(userId, file);

    expect(key).toMatch(new RegExp(`^${userId}-[0-9a-f-]{36}\\.jpg$`));
    expect(avatarUrl).toBe(`https://cdn.test/${key}`);
    expect(manager.user.update).toHaveBeenCalledWith({
      where: { id: userId, deletedAt: null },
      data: { avatarKey: key },
    });
    expect(manager.avatarCleanupTask.upsert).not.toHaveBeenCalled();
    expect(manager.avatarCleanupTask.delete).toHaveBeenCalledWith({
      where: { objectKey: key },
    });
    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.avatar.updated',
        payload: { change: 'ADDED' },
      }),
      manager,
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
    expect(cleanup.processDue).toHaveBeenCalledOnce();
  });

  it('schedules cleanup of the replaced avatar', async () => {
    const { service, manager, logging } = setup();
    manager.user.findUnique.mockResolvedValue({ avatarKey: 'old.jpg' });

    await service.upload(userId, file);

    expect(manager.avatarCleanupTask.upsert).toHaveBeenCalledWith({
      where: { objectKey: 'old.jpg' },
      create: { objectKey: 'old.jpg' },
      update: { nextAttemptAt: expect.any(Date) },
    });
    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { change: 'REPLACED' } }),
      manager,
    );
  });

  it('keeps the recovery task and skips the audit when the user vanished', async () => {
    const { service, manager, logging, cleanup } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(service.upload(userId, file)).rejects.toMatchObject({
      status: 404,
    });
    expect(manager.avatarCleanupTask.delete).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    expect(cleanup.processDue).not.toHaveBeenCalled();
  });

  it('does not touch the database when storage upload fails', async () => {
    const { service, s3, manager } = setup();
    s3.upload.mockRejectedValue(new Error('s3 down'));

    await expect(service.upload(userId, file)).rejects.toThrow('s3 down');
    expect(manager.user.update).not.toHaveBeenCalled();
  });
});
