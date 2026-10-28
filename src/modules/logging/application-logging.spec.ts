import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import { LoggingService } from './logging.service.js';
import { parseApplicationEvent } from './schemas/application-event.schema.js';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '123e4567-e89b-42d3-a456-426614174001';
const event = {
  event: 'auth.refresh_failed' as const,
  requestContext: { requestId },
};

describe('Application logging boundaries', () => {
  it('removes secrets and caller policy overrides without mutating input', () => {
    const input = {
      ...event,
      message: 'secret-message',
      level: 'debug',
      category: 'security',
      error: new Error('secret-error'),
      metadata: { password: 'secret-password' },
      requestContext: { requestId, authorization: 'secret-token' },
    };
    expect(parseApplicationEvent(input)).toEqual(event);
    expect(input.requestContext.authorization).toBe('secret-token');
  });

  it('accepts the scoped logout event', () => {
    const input = {
      event: 'auth.logout_failed',
      userId,
      scope: 'all_sessions',
      requestContext: { requestId },
    };
    expect(parseApplicationEvent(input)).toEqual(input);
  });

  it.each([
    { event: 'unknown-secret-event', requestContext: { requestId } },
    { ...event, requestContext: { requestId: 'secret-token' } },
    {
      event: 'auth.logout_failed',
      scope: 'all_sessions',
      requestContext: { requestId },
    },
    {
      event: 'auth.logout_failed',
      userId,
      scope: 'session_family',
      requestContext: { requestId },
    },
  ])('rejects invalid core data without exposing values', (input) => {
    expect(() => parseApplicationEvent(input)).toThrow(
      'Invalid application event',
    );
  });

  it('applies server policy and envelope before writing', () => {
    const log = vi.fn();
    const logger = { on: vi.fn(), off: vi.fn(), log } as unknown as Logger;
    const service = new LoggingService(
      logger,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    service.application({
      ...event,
      message: 'secret-message',
    } as typeof event);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatchObject({
      ...event,
      level: 'error',
      category: 'application',
      message: 'Refresh token processing failed',
      environment: 'test',
      schemaVersion: 1,
      eventId: expect.any(String),
      occurredAt: expect.any(String),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-message');
  });

  it('contains logger failures and emits only one safe fallback', () => {
    const logger = {
      on: vi.fn(),
      off: vi.fn(),
      log: vi.fn(() => {
        throw new Error('secret-transport-error');
      }),
    } as unknown as Logger;
    const service = new LoggingService(logger, new ConfigService());
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(() => service.application(event)).not.toThrow();
      expect(() => service.application(event)).not.toThrow();
      expect(service.getFailureCount()).toBe(2);
      expect(stderr).toHaveBeenCalledOnce();
      expect(String(stderr.mock.calls[0][0])).toContain(
        'APPLICATION_LOG_FAILED',
      );
      expect(String(stderr.mock.calls[0][0])).not.toContain(
        'secret-transport-error',
      );
    } finally {
      stderr.mockRestore();
    }
  });
});
