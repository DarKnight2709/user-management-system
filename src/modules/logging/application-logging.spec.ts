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
    {
      event: 'http.operational_error',
      statusCode: 503,
      requestContext: { requestId },
    },
    {
      event: 'http.payload_too_large',
      statusCode: 413,
      requestContext: { requestId },
    },
    {
      event: 'http.unhandled_error',
      statusCode: 500,
      errorType: 'TypeError',
      stackFrames: ['    at handler (fixture.ts:1:1)'],
      requestContext: { requestId },
    },
    {
      event: 'database.unhandled_error',
      code: 'P2021',
      requestContext: { requestId },
    },
    { event: 'database.info' },
    { event: 'database.warning', requestContext: { requestId } },
    { event: 'database.error' },
    {
      event: 'database.query_completed',
      queryFingerprint: 'a'.repeat(64),
      durationMs: 12.5,
    },
    {
      event: 'database.slow_query',
      queryFingerprint: 'b'.repeat(64),
      durationMs: 100,
      thresholdMs: 100,
      requestContext: { requestId },
    },
    {
      event: 'avatar.cleanup_worker_failed',
      errorCategory: 'database',
    },
    {
      event: 'avatar.cleanup_retry_scheduling_failed',
      taskId: userId,
      attempt: 2,
      errorCategory: 'storage_unavailable',
      schedulingErrorCategory: 'database',
    },
    {
      event: 'avatar.cleanup_retry_scheduled',
      taskId: userId,
      attempt: 2,
      errorCategory: 'timeout',
      retryDelayMs: 60_000,
    },
  ])('accepts the safe diagnostic event $event', (input) => {
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

  it('raises caused server-side HTTP diagnostics to error level', () => {
    const log = vi.fn();
    const logger = { on: vi.fn(), off: vi.fn(), log } as unknown as Logger;
    const service = new LoggingService(
      logger,
      new ConfigService({ NODE_ENV: 'test' }),
    );
    service.application({
      event: 'http.operational_error',
      statusCode: 503,
      requestContext: { requestId },
    });
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'http.operational_error',
      level: 'error',
      message: 'HTTP request failed',
    });
  });

  it('writes opted-in query diagnostics at debug without inventing a request ID', () => {
    const log = vi.fn();
    const logger = { on: vi.fn(), off: vi.fn(), log } as unknown as Logger;
    const service = new LoggingService(
      logger,
      new ConfigService({ NODE_ENV: 'development' }),
    );
    service.application({
      event: 'database.query_completed',
      queryFingerprint: 'a'.repeat(64),
      durationMs: 12.5,
    });
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'database.query_completed',
      level: 'debug',
      message: 'Database query completed',
    });
    expect(log.mock.calls[0][0]).not.toHaveProperty('requestId');
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
