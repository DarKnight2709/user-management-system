import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import { MAX_EVENT_BYTES } from '../constants/logging.constant.js';
import { LogEmitter } from '../log-emitter.js';

function setup(env = 'test') {
  const logger = { on: vi.fn(), off: vi.fn(), log: vi.fn() };
  const emitter = new LogEmitter(
    logger as unknown as Logger,
    new ConfigService({ NODE_ENV: env }),
  );
  return { emitter, logger };
}

describe('LogEmitter', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('listens for transport errors and removes the same listener on dispose', () => {
    const { emitter, logger } = setup();
    const listener = logger.on.mock.calls[0][1] as () => void;

    expect(logger.on).toHaveBeenCalledWith('error', listener);
    emitter.dispose();
    expect(logger.off).toHaveBeenCalledWith('error', listener);
  });

  it('counts Winston transport errors without calling Winston again', () => {
    const { emitter, logger } = setup();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    (logger.on.mock.calls[0][1] as () => void)();

    expect(emitter.getFailureCount()).toBe(1);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('creates a fresh envelope with the configured environment', () => {
    const { emitter } = setup('staging');

    const first = emitter.envelope();
    const second = emitter.envelope();

    expect(first).toMatchObject({ schemaVersion: 1, environment: 'staging' });
    expect(first.eventId).not.toBe(second.eventId);
    expect(new Date(first.occurredAt).toISOString()).toBe(first.occurredAt);
  });

  it('defaults the environment to development', () => {
    // ConfigService falls back to process.env, which vitest sets to "test".
    vi.stubEnv('NODE_ENV', undefined);
    const logger = { on: vi.fn(), off: vi.fn(), log: vi.fn() };
    const emitter = new LogEmitter(
      logger as unknown as Logger,
      new ConfigService({}),
    );

    expect(emitter.envelope().environment).toBe('development');
  });

  it('writes a detached plain copy with the requested level and message', () => {
    const { emitter, logger } = setup();
    const nested = { value: 1 };

    emitter.write('warn', { message: 'hello', nested });
    nested.value = 2;

    const entry = logger.log.mock.calls[0][0] as {
      nested: { value: number };
    };
    expect(entry).toMatchObject({ level: 'warn', message: 'hello' });
    expect(entry.nested.value).toBe(1);
  });

  it('rejects events over the size limit before writing', () => {
    const { emitter, logger } = setup();

    expect(() =>
      emitter.write('info', {
        message: 'big',
        data: 'x'.repeat(MAX_EVENT_BYTES),
      }),
    ).toThrow('Log event exceeds size limit');
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('measures the size limit in UTF-8 bytes', () => {
    const { emitter } = setup();

    // Fewer characters than the limit, but more bytes.
    expect(() =>
      emitter.serialize({ data: 'é'.repeat(MAX_EVENT_BYTES * 0.6) }),
    ).toThrow('Log event exceeds size limit');
    expect(() => emitter.serialize({ data: 'ok' })).not.toThrow();
  });

  it('prints only the first failure fallback but counts every failure', () => {
    const { emitter } = setup();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    emitter.reportFailure('SECURITY_LOG_FAILED');
    emitter.reportFailure('APPLICATION_LOG_FAILED');
    emitter.reportFailure('AUDIT_COPY_FAILED');

    expect(emitter.getFailureCount()).toBe(3);
    expect(stderr).toHaveBeenCalledOnce();
    const printed = JSON.parse(String(stderr.mock.calls[0][0])) as object;
    expect(printed).toMatchObject({
      category: 'logging_internal',
      reason: 'SECURITY_LOG_FAILED',
    });
  });

  it('survives a failing stderr fallback', () => {
    const { emitter } = setup();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr closed');
    });

    expect(() => emitter.reportFailure('SECURITY_LOG_FAILED')).not.toThrow();
    expect(emitter.getFailureCount()).toBe(1);
  });
});
