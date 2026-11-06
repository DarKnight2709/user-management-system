import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { PasswordService } from '../services/password.service.js';
import type { ChangePasswordDto } from '../dto/change-password.dto.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));
vi.mock('@/common/utils/hash.util.js', () => ({
  hash: vi.fn((plain: string) => Promise.resolve(`hashed:${plain}`)),
  compare: vi.fn((plain: string, hashed: string) =>
    Promise.resolve(`hashed:${plain}` === hashed),
  ),
}));

const userId = '123e4567-e89b-42d3-a456-426614174001';
const passwords = {
  currentPassword: 'current-password-123',
  newPassword: 'brand-new-password-456',
};
const dto = passwords as ChangePasswordDto;
const withPasswords = (overrides: Partial<typeof passwords>) =>
  ({ ...passwords, ...overrides }) as ChangePasswordDto;

function setup() {
  const manager = {
    user: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    refreshToken: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
  };
  const prisma = Object.assign(createPrismaStub(manager), {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ hashedPassword: `hashed:${dto.currentPassword}` }),
    },
  });
  const auditEvent = { eventId: 'audit' };
  const logging = {
    audit: vi.fn().mockResolvedValue(auditEvent),
    publishCommittedAudit: vi.fn(),
    security: vi.fn(),
  };
  const service = new PasswordService(
    prisma,
    logging as unknown as LoggingService,
  );
  return { service, manager, prisma, logging, auditEvent };
}

describe('PasswordService.changePassword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects deleted or unknown accounts', async () => {
    const { service, prisma, manager } = setup();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.changePassword(userId, dto)).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.user.updateMany).not.toHaveBeenCalled();
  });

  it('logs and rejects a wrong current password', async () => {
    const { service, logging, manager } = setup();

    await expect(
      service.changePassword(
        userId,
        withPasswords({ currentPassword: 'wrong' }),
      ),
    ).rejects.toMatchObject({ status: 401 });

    expect(logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.password.change_failed',
        reasonCode: 'INVALID_CURRENT_PASSWORD',
      }),
    );
    expect(manager.user.updateMany).not.toHaveBeenCalled();
  });

  it('rejects reusing the current password with 400', async () => {
    const { service, manager } = setup();

    await expect(
      service.changePassword(
        userId,
        withPasswords({ newPassword: passwords.currentPassword }),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(manager.user.updateMany).not.toHaveBeenCalled();
  });

  it('swaps the hash only if it is unchanged, then revokes all sessions', async () => {
    const { service, manager } = setup();

    await service.changePassword(userId, dto);

    expect(manager.user.updateMany).toHaveBeenCalledWith({
      where: {
        id: userId,
        deletedAt: null,
        hashedPassword: `hashed:${dto.currentPassword}`,
      },
      data: { hashedPassword: `hashed:${dto.newPassword}` },
    });
    expect(manager.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('fails when a concurrent change already replaced the hash', async () => {
    const { service, manager, logging } = setup();
    manager.user.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.changePassword(userId, dto)).rejects.toMatchObject({
      status: 401,
    });
    expect(manager.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
  });

  it('audits in the transaction, then publishes and logs after commit', async () => {
    const { service, manager, logging, auditEvent } = setup();

    await service.changePassword(userId, dto, '10.0.0.1', 'agent');

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.password.changed',
        payload: { revokedRefreshTokenCount: 3 },
      }),
      manager,
    );
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(auditEvent);
    expect(logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.password.changed',
        requestContext: expect.objectContaining({ sourceIp: '10.0.0.1' }),
      }),
    );
  });

  it('publishes nothing when the audit write fails', async () => {
    const { service, logging } = setup();
    logging.audit.mockRejectedValue(new Error('audit down'));

    await expect(service.changePassword(userId, dto)).rejects.toThrow(
      'audit down',
    );
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    expect(logging.security).not.toHaveBeenCalled();
  });

  it('never logs password values', async () => {
    const { service, logging } = setup();

    await service.changePassword(userId, dto);

    const logged = JSON.stringify([
      logging.audit.mock.calls,
      logging.security.mock.calls,
    ]);
    expect(logged).not.toContain(dto.currentPassword);
    expect(logged).not.toContain(dto.newPassword);
  });
});
