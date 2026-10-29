import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createLogger, transports } from 'winston';
import { flushLogger } from './flush-logger.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';

vi.mock('./flush-logger.js', () => ({ flushLogger: vi.fn() }));

class FixtureProcess extends EventEmitter {
  exit = vi.fn();
}
function fixture() {
  const platform = new FixtureProcess();
  const logger = createLogger({ transports: [new transports.Console()] });
  const writeShutdownEvent = vi.fn();
  return { platform, logger, writeShutdownEvent };
}

describe('Graceful shutdown coordinator', () => {
  beforeEach(() => {
    vi.mocked(flushLogger).mockReset().mockResolvedValue('flushed');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'handles %s once and waits for close and flush before exit',
    async (signal, code) => {
      const { platform, logger, writeShutdownEvent } = fixture();
      let finishClose!: () => void;
      let finishFlush!: () => void;
      const close = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishClose = resolve;
          }),
      );
      vi.mocked(flushLogger).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishFlush = () => resolve('flushed');
          }),
      );
      const coordinator = registerGracefulShutdown(
        { close },
        logger,
        writeShutdownEvent,
        { platform },
      );
      platform.emit(signal);
      platform.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
      expect(close).toHaveBeenCalledExactlyOnceWith(signal);
      expect(writeShutdownEvent).toHaveBeenCalledWith({
        event: 'application.shutdown_started',
        signal,
      });
      expect(flushLogger).not.toHaveBeenCalled();
      finishClose();
      await vi.waitFor(() => expect(flushLogger).toHaveBeenCalledOnce());
      expect(platform.exit).not.toHaveBeenCalled();
      finishFlush();
      await coordinator.shutdown(signal);
      expect(platform.exit).toHaveBeenCalledExactlyOnceWith(code);
      expect(platform.listenerCount('SIGINT')).toBe(0);
      expect(platform.listenerCount('SIGTERM')).toBe(0);
      logger.close();
    },
  );

  it('does not end the logger if application cleanup rejects', async () => {
    const { platform, logger, writeShutdownEvent } = fixture();
    const close = vi
      .fn()
      .mockRejectedValue(new Error('Fixture private failure'));
    const coordinator = registerGracefulShutdown(
      { close },
      logger,
      writeShutdownEvent,
      { platform },
    );
    await coordinator.shutdown('SIGTERM');
    expect(flushLogger).not.toHaveBeenCalled();
    expect(writeShutdownEvent).toHaveBeenCalledWith({
      event: 'application.shutdown_failed',
      signal: 'SIGTERM',
    });
    expect(platform.exit).toHaveBeenCalledExactlyOnceWith(1);
    logger.close();
  });

  it('continues shutdown if lifecycle event logging throws', async () => {
    const { platform, logger, writeShutdownEvent } = fixture();
    writeShutdownEvent.mockImplementation(() => {
      throw new Error('Fixture logging failure');
    });
    const coordinator = registerGracefulShutdown(
      { close: vi.fn().mockResolvedValue(undefined) },
      logger,
      writeShutdownEvent,
      { platform },
    );

    await coordinator.shutdown('SIGTERM');

    expect(writeShutdownEvent).toHaveBeenCalledWith({
      event: 'application.shutdown_started',
      signal: 'SIGTERM',
    });
    expect(flushLogger).toHaveBeenCalledOnce();
    expect(platform.exit).toHaveBeenCalledExactlyOnceWith(143);
    logger.close();
  });

  it.each(['failed', 'timeout'] as const)(
    'exits unsuccessfully if flushing reports %s',
    async (result) => {
      const { platform, logger, writeShutdownEvent } = fixture();
      vi.mocked(flushLogger).mockResolvedValue(result);
      const coordinator = registerGracefulShutdown(
        { close: vi.fn().mockResolvedValue(undefined) },
        logger,
        writeShutdownEvent,
        { platform },
      );
      await coordinator.shutdown('SIGTERM');
      expect(platform.exit).toHaveBeenCalledExactlyOnceWith(1);
      logger.close();
    },
  );

  it('bounds total shutdown and ignores late completion after the deadline', async () => {
    vi.useFakeTimers();
    const { platform, logger, writeShutdownEvent } = fixture();
    let finishClose!: () => void;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishClose = resolve;
        }),
    );
    const coordinator = registerGracefulShutdown(
      { close },
      logger,
      writeShutdownEvent,
      { platform, shutdownTimeoutMs: 100 },
    );
    const pending = coordinator.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(100);
    expect(platform.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(flushLogger).not.toHaveBeenCalled();
    finishClose();
    await pending;
    expect(flushLogger).not.toHaveBeenCalled();
    expect(platform.exit).toHaveBeenCalledTimes(1);
    logger.close();
  });

  it('runs actual Nest lifecycle hooks, preserves the signal, then flushes', async () => {
    const events: string[] = [];
    @Injectable()
    class FixtureWorker {
      async onModuleDestroy() {
        await Promise.resolve();
        events.push('worker stopped');
      }
      beforeApplicationShutdown(signal?: string) {
        events.push(`before:${signal}`);
      }
      async onApplicationShutdown(signal?: string) {
        await Promise.resolve();
        events.push(`last log:${signal}`);
      }
    }
    @Module({ providers: [FixtureWorker] })
    class FixtureModule {}
    const app = await NestFactory.create(FixtureModule, { logger: false });
    await app.init();
    const { platform, logger, writeShutdownEvent } = fixture();
    vi.mocked(flushLogger).mockImplementation(async () => {
      events.push('flush');
      return 'flushed';
    });
    const coordinator = registerGracefulShutdown(
      app,
      logger,
      writeShutdownEvent,
      { platform },
    );
    await coordinator.shutdown('SIGTERM');
    expect(events).toEqual([
      'worker stopped',
      'before:SIGTERM',
      'last log:SIGTERM',
      'flush',
    ]);
    expect(platform.exit).toHaveBeenCalledWith(143);
    logger.close();
  });
});
