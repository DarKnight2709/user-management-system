import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { PrismaService } from './prisma.service.js';

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
  return new PrismaService(
    new ConfigService({
      DATABASE_URL: 'postgresql://fixture.invalid/unused',
      NODE_ENV: environment,
      LOG_DATABASE_QUERIES: enabled,
    }),
  );
}

const logSpies = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('Prisma safe logging', () => {
  beforeEach(() => {
    state.listeners.clear();
    for (const spy of Object.values(logSpies)) spy.mockClear();
    vi.spyOn(Logger, 'log').mockImplementation(logSpies.log);
    vi.spyOn(Logger, 'warn').mockImplementation(logSpies.warn);
    vi.spyOn(Logger, 'error').mockImplementation(logSpies.error);
    vi.spyOn(Logger, 'debug').mockImplementation(logSpies.debug);
  });
  afterEach(() => vi.restoreAllMocks());

  it('routes every configured level through events and never forwards driver payloads', () => {
    initialize();
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
    expect(logSpies.log).toHaveBeenCalledWith(
      { message: 'Database information event', event: 'database.info' },
      'PrismaService',
    );
    expect(logSpies.warn).toHaveBeenCalledWith(
      { message: 'Database warning', event: 'database.warning' },
      'PrismaService',
    );
    expect(logSpies.error).toHaveBeenCalledWith(
      { message: 'Database error event', event: 'database.error' },
      undefined,
      'PrismaService',
    );
    const calls = [
      logSpies.log.mock.calls,
      logSpies.warn.mock.calls,
      logSpies.error.mock.calls,
    ];
    expect(JSON.stringify(calls)).not.toContain('private-');
  });

  it('logs only fingerprint and duration for development query debugging', () => {
    initialize('development', true);
    const query = "SELECT 'private-literal'";
    state.listeners.get('query')!({
      query,
      params: '["private-parameter"]',
      duration: 25,
    });
    expect(logSpies.debug).toHaveBeenCalledWith(
      {
        message: 'Database query completed',
        event: 'database_query',
        queryFingerprint: createHash('sha256').update(query).digest('hex'),
        durationMs: 25,
      },
      'PrismaService',
    );
    expect(JSON.stringify(logSpies.debug.mock.calls)).not.toContain('private-');
    expect(logSpies.warn).not.toHaveBeenCalled();
  });

  it.each(['development', 'production', 'test'])(
    'keeps slow warnings in %s and only enables debugging in opted-in development',
    (environment) => {
      initialize(environment, false);
      state.listeners.get('query')!({ query: 'SELECT 1', duration: 99 });
      expect(logSpies.warn).not.toHaveBeenCalled();
      state.listeners.get('query')!({ query: 'SELECT 1', duration: 100 });
      expect(logSpies.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Slow database query',
          event: 'slow_database_query',
          durationMs: 100,
          thresholdMs: 100,
        }),
        'PrismaService',
      );
      expect(logSpies.debug).not.toHaveBeenCalled();
    },
  );

  it('does not enable production query debugging even when opted in', () => {
    initialize('production', true);
    state.listeners.get('query')!({ query: 'SELECT 1', duration: 25 });
    expect(logSpies.debug).not.toHaveBeenCalled();
  });
});
