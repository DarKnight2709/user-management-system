import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import type { Prisma } from '@/generated/prisma/client.js';
import { LoggingService } from '../logging.service.js';

const requestId = randomUUID();
const userId = randomUUID();

function setup() {
  const logger = { on: vi.fn(), off: vi.fn(), log: vi.fn() };
  const service = new LoggingService(
    logger as unknown as Logger,
    new ConfigService({ NODE_ENV: 'test' }),
  );
  return { service, logger };
}

describe('LoggingService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('application', () => {
    it('never throws and counts an invalid event as a failure', () => {
      const { service, logger } = setup();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(() =>
        service.application({ event: 'no.such.event' } as never),
      ).not.toThrow();

      expect(logger.log).not.toHaveBeenCalled();
      expect(service.getFailureCount()).toBe(1);
    });

    it('counts a failing transport without throwing', () => {
      const { service, logger } = setup();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      logger.log.mockImplementation(() => {
        throw new Error('transport');
      });

      expect(() =>
        service.application({ event: 'application.started', port: 3000 }),
      ).not.toThrow();
      expect(service.getFailureCount()).toBe(1);
    });

    it('adds the request id and envelope to the entry', () => {
      const { service, logger } = setup();

      service.application({
        event: 'auth.refresh_failed',
        requestContext: { requestId },
      });

      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.refresh_failed',
          requestId,
          environment: 'test',
          context: 'LoggingService',
        }),
      );
    });
  });

  describe('security', () => {
    it('lets policy decide level, category and outcome', () => {
      const { service, logger } = setup();

      service.security({
        action: 'authorization.denied',
        actor: { type: 'USER', id: userId },
        scope: 'PLATFORM',
        reasonCode: 'INSUFFICIENT_PLATFORM_PERMISSION',
        requiredPermissions: [{ resource: 'USER', action: 'read' }],
        requestContext: { requestId },
      } as never);

      expect(service.getFailureCount()).toBe(0);
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warn',
          category: 'security',
          outcome: 'FAILURE',
          message: 'authorization.denied',
          event: 'authorization.denied',
        }),
      );
    });

    it('swallows invalid security events', () => {
      const { service, logger } = setup();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);

      expect(() => service.security({ action: 'nope' } as never)).not.toThrow();
      expect(logger.log).not.toHaveBeenCalled();
      expect(service.getFailureCount()).toBe(1);
    });
  });

  describe('audit', () => {
    const event = () =>
      ({
        action: 'user.deleted',
        actor: { type: 'USER', id: userId },
        target: { type: 'USER', id: randomUUID() },
        payload: { selfDeletion: true, revokedRefreshTokenCount: 0 },
        requestContext: { requestId },
      }) as const;

    it('stores through the supplied transaction client and does not log yet', async () => {
      const { service, logger } = setup();
      const create = vi.fn().mockResolvedValue({});
      const manager = {
        auditEvent: { create },
      } as unknown as Prisma.TransactionClient;

      const stored = await service.audit(event(), manager);

      expect(create).toHaveBeenCalledOnce();
      expect(logger.log).not.toHaveBeenCalled();
      expect(stored.action).toBe('user.deleted');
    });

    it('publishes the committed copy and reports copy failures only via the counter', async () => {
      const { service, logger } = setup();
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const manager = {
        auditEvent: { create: vi.fn().mockResolvedValue({}) },
      } as unknown as Prisma.TransactionClient;
      const stored = await service.audit(event(), manager);

      service.publishCommittedAudit(stored);
      expect(logger.log).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'user.deleted', level: 'info' }),
      );

      logger.log.mockImplementation(() => {
        throw new Error('transport');
      });
      expect(() => service.publishCommittedAudit(stored)).not.toThrow();
      expect(service.getFailureCount()).toBe(1);
    });
  });

  it('detaches its Winston listener on module destroy', () => {
    const { service, logger } = setup();

    service.onModuleDestroy();

    expect(logger.off).toHaveBeenCalledWith(
      'error',
      logger.on.mock.calls[0][1],
    );
  });
});
