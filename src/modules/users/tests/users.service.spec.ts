import { describe, expect, it, vi } from 'vitest';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { S3Service } from '@/core/storage/s3.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { UsersService } from '../users.service.js';
import type { CreateUserDto, UpdateUserDto } from '../dto/user.dto.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const targetId = '423e4567-e89b-42d3-a456-426614174000';

const storedUser = (overrides: Record<string, unknown> = {}) => ({
  id: targetId,
  username: 'alice',
  email: 'alice@example.com',
  firstName: 'Alice',
  lastName: 'Doe',
  birthDate: new Date('2000-01-01'),
  avatarKey: 'alice.jpg',
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  ...overrides,
});

function setup() {
  const manager = {
    user: {
      findUnique: vi.fn().mockResolvedValue(storedUser()),
      findMany: vi.fn().mockResolvedValue([storedUser()]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(storedUser()),
      update: vi.fn().mockResolvedValue(storedUser({ firstName: 'Alicia' })),
    },
  };
  const prisma = Object.assign(createPrismaStub(manager), {
    user: { findUnique: vi.fn().mockResolvedValue(storedUser()) },
  });
  const s3 = {
    getPublicUrl: vi.fn((key: string | null) =>
      key ? `https://cdn.test/${key}` : null,
    ),
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasPlatformPermission: vi.fn().mockResolvedValue(true),
  };
  const auditEvent = { id: 'audit-id' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
  };
  const service = new UsersService(
    prisma,
    s3 as unknown as S3Service,
    permissions as unknown as PermissionsService,
    logging as unknown as LoggingService,
  );
  return { service, manager, prisma, permissions, logging, auditEvent };
}

describe('UsersService.findAllForActor', () => {
  it('rejects inactive actors', async () => {
    const { service, permissions, manager } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(service.findAllForActor({ actorId })).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.user.findMany).not.toHaveBeenCalled();
  });

  it('requires platform USER:read with the transaction client', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasPlatformPermission.mockResolvedValue(false);

    await expect(service.findAllForActor({ actorId })).rejects.toMatchObject({
      status: 403,
    });
    expect(permissions.hasPlatformPermission).toHaveBeenCalledWith(
      actorId,
      { resource: 'USER', action: 'read' },
      manager,
    );
    expect(manager.user.findMany).not.toHaveBeenCalled();
  });

  it('pages active users deterministically without password hashes', async () => {
    const { service, manager } = setup();

    const result = await service.findAllForActor({
      actorId,
      page: 3,
      limit: 10,
    });

    expect(manager.user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      omit: { hashedPassword: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip: 20,
      take: 10,
    });
    expect(manager.user.count).toHaveBeenCalledWith({
      where: { deletedAt: null },
    });
    expect(result).toMatchObject({ total: 1, page: 3, limit: 10 });
  });

  it('replaces avatarKey with avatarUrl in each item', async () => {
    const { service } = setup();

    const { items } = await service.findAllForActor({ actorId });

    expect(items[0]).toMatchObject({ avatarUrl: 'https://cdn.test/alice.jpg' });
    expect(items[0]).not.toHaveProperty('avatarKey');
  });

  it('defaults to page 1 and limit 20', async () => {
    const { service, manager } = setup();

    const result = await service.findAllForActor({ actorId });

    expect(result).toMatchObject({ page: 1, limit: 20 });
    expect(manager.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
  });

  it.each([
    { page: 0, limit: 20 },
    { page: 1, limit: 101 },
    { page: 1.5, limit: 20 },
  ])('rejects invalid pagination %j before any query', async (pagination) => {
    const { service, manager } = setup();

    await expect(
      service.findAllForActor({ actorId, ...pagination }),
    ).rejects.toBeDefined();
    expect(manager.user.findMany).not.toHaveBeenCalled();
  });
});

describe('UsersService.findOneForActor', () => {
  it('rejects inactive actors', async () => {
    const { service, permissions } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      service.findOneForActor({ actorId, targetId }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('allows self-access without a platform permission check', async () => {
    const { service, permissions } = setup();

    const user = await service.findOneForActor({
      actorId,
      targetId: actorId,
    });

    expect(permissions.hasPlatformPermission).not.toHaveBeenCalled();
    expect(user.avatarUrl).toBe('https://cdn.test/alice.jpg');
  });

  it('forbids cross-account reads without USER:read, before target lookup', async () => {
    const { service, permissions, manager } = setup();
    permissions.hasPlatformPermission.mockResolvedValue(false);

    await expect(
      service.findOneForActor({ actorId, targetId }),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns 404 for an authorized read of a missing or deleted user', async () => {
    const { service, manager } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(
      service.findOneForActor({ actorId, targetId }),
    ).rejects.toMatchObject({ status: 404 });
    expect(manager.user.findUnique).toHaveBeenCalledWith({
      where: { id: targetId, deletedAt: null },
      omit: { hashedPassword: true },
    });
  });
});

describe('UsersService internal lookups', () => {
  it('findOne throws 404 for inactive users', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.findOne(targetId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('findOneByEmail normalizes the email and returns null when absent', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.findOneByEmail('  Alice@Example.COM '),
    ).resolves.toBeNull();
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'alice@example.com', deletedAt: null },
    });
  });
});

describe('UsersService.create', () => {
  const dto = {
    firstName: 'Alice',
    lastName: 'Doe',
    birthDate: new Date('2000-01-01'),
    hashedPassword: 'hash',
    email: ' Alice@Example.com ',
    username: ' Alice ',
  } as CreateUserDto;

  it('normalizes identifiers and omits the hash from the result', async () => {
    const { service, manager } = setup();

    const user = await service.create(dto);

    expect(manager.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'alice@example.com',
        username: 'alice',
        hashedPassword: 'hash',
      }),
      omit: { hashedPassword: true },
    });
    expect(user).not.toHaveProperty('avatarKey');
  });

  it('audits registration in the transaction and publishes after commit', async () => {
    const { service, manager, logging, auditEvent } = setup();

    await service.create(dto);

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.registered',
        actor: { type: 'ANONYMOUS' },
      }),
      manager,
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
  });

  it('does not publish when creation fails', async () => {
    const { service, manager, logging } = setup();
    manager.user.create.mockRejectedValue(new Error('unique'));

    await expect(service.create(dto)).rejects.toThrow('unique');
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });
});

describe('UsersService.update', () => {
  const sameProfile: Record<string, unknown> = {
    username: 'alice',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Doe',
    birthDate: new Date('2000-01-01'),
  };

  it('returns 404 for inactive users', async () => {
    const { service, manager } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(
      service.update(targetId, sameProfile as unknown as UpdateUserDto),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('skips the write and audit when nothing changed', async () => {
    const { service, manager, logging } = setup();

    await service.update(targetId, sameProfile as unknown as UpdateUserDto);

    expect(manager.user.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('writes and audits only the changed fields', async () => {
    const { service, manager, logging } = setup();

    await service.update(targetId, {
      ...sameProfile,
      firstName: 'Alicia',
      username: ' ALICE ',
    } as unknown as UpdateUserDto);

    expect(manager.user.update).toHaveBeenCalledWith({
      where: { id: targetId, deletedAt: null },
      data: expect.objectContaining({ firstName: 'Alicia', username: 'alice' }),
      omit: { hashedPassword: true },
    });
    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.profile.updated',
        payload: { changedFields: ['firstName'] },
      }),
      manager,
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
  });
});
