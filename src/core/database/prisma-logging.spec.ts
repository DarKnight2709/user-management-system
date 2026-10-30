import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

const state = vi.hoisted(() => ({
  listeners: new Map<string, (event: unknown) => void>(),
  options: undefined as unknown,
}));

vi.mock('@/generated/prisma/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PrismaClient: class {
    constructor(options: unknown) {
      state.options = options;
    }
    $on(name: string, listener: (event: unknown) => void) {
      state.listeners.set(name, listener);
    }
  },
}));
vi.mock('pg', () => ({ Pool: class {} }));
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));

function initialize(environment = 'production', enabled = false) {
  const application = vi.fn();
  const logging = { application } as unknown as LoggingService;
  new PrismaService(
    new ConfigService({
      DATABASE_URL: 'postgresql://fixture.invalid/unused',
      NODE_ENV: environment,
      LOG_DATABASE_QUERIES: enabled,
    }),
    logging,
  );
  return application;
}

describe('Prisma safe logging', () => {
  beforeEach(() => {
    state.listeners.clear();
  });

  it('routes every configured level through events and never forwards driver payloads', () => {
    const application = initialize();
    expect(state.options).toMatchObject({
      log: [
        { emit: 'event', level: 'query' },
        { emit: 'event', level: 'info' },
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
    for (const level of ['info', 'warn', 'error']) {
      state.listeners.get(level)!({
        message: 'password=private-password',
        target: 'private-target',
      });
    }
    expect(application.mock.calls.map(([event]) => event)).toEqual([
      { event: 'database.info' },
      { event: 'database.warning' },
      { event: 'database.error' },
    ]);
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
  });

  it('logs only fingerprint and duration for development query debugging', () => {
    const application = initialize('development', true);
    const query = "SELECT 'private-literal'";
    state.listeners.get('query')!({
      query,
      params: '["private-parameter"]',
      duration: 25,
    });
    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'database.query_completed',
      queryFingerprint: createHash('sha256').update(query).digest('hex'),
      durationMs: 25,
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
  });

  it.each(['development', 'production', 'test'])(
    'keeps slow warnings in %s and only enables debugging in opted-in development',
    (environment) => {
      const application = initialize(environment, false);
      state.listeners.get('query')!({ query: 'SELECT 1', duration: 99 });
      expect(application).not.toHaveBeenCalled();
      state.listeners.get('query')!({ query: 'SELECT 1', duration: 100 });
      expect(application).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: 'database.slow_query',
          durationMs: 100,
          thresholdMs: 100,
        }),
      );
    },
  );

  it('does not enable production query debugging even when opted in', () => {
    const application = initialize('production', true);
    state.listeners.get('query')!({ query: 'SELECT 1', duration: 25 });
    expect(application).not.toHaveBeenCalled();
  });

  it('correlates database events only when an HTTP request context exists', () => {
    const application = initialize();
    const requestId = '123e4567-e89b-42d3-a456-426614174000';
    requestContext.run({ requestId }, () => {
      state.listeners.get('warn')!({ message: 'private-driver-message' });
    });
    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'database.warning',
      requestContext: { requestId },
    });
  });
});
