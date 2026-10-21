import { Logger } from '@nestjs/common';
import type { Logger as WinstonLogger } from 'winston';
import { flushLogger } from './flush-logger.js';

type Signal = 'SIGINT' | 'SIGTERM';

interface ShutdownProcess {
  on(signal: Signal, listener: () => void): unknown;
  removeListener(signal: Signal, listener: () => void): unknown;
  exit(code: number): unknown;
}

export function registerGracefulShutdown(
  app: { close(signal?: string): Promise<void> },
  logger: WinstonLogger,
  {
    platform = process,
    shutdownTimeoutMs = 30_000,
    flushTimeoutMs = 2_000,
  }: {
    platform?: ShutdownProcess;
    shutdownTimeoutMs?: number;
    flushTimeoutMs?: number;
  } = {},
) {
  const lifecycleLogger = new Logger('Shutdown');
  let shutdownPromise: Promise<void> | undefined;
  let exiting = false;

  const removeListeners = () => {
    platform.removeListener('SIGINT', onInterrupt);
    platform.removeListener('SIGTERM', onTerminate);
  };

  const performShutdown = async (signal: Signal): Promise<void> => {
    const deadline = setTimeout(() => {
      exiting = true;
      removeListeners();
      platform.exit(1);
    }, shutdownTimeoutMs);
    try {
      lifecycleLogger.log({
        message: 'Application shutdown started',
        event: 'application.shutdown',
        signal,
      });
      try {
        // Nest 12 forwards this signal to its lifecycle hooks.
        await app.close(signal);
      } catch {
        if (exiting) return;
        lifecycleLogger.error(
          {
            message: 'Application shutdown failed',
            event: 'application.shutdown_failed',
          },
          undefined,
        );
        // Cleanup did not complete: do not end a logger that workers may still use.
        exiting = true;
        platform.exit(1);
        return;
      }
      if (exiting) return;
      const result = await flushLogger(logger, { timeoutMs: flushTimeoutMs });
      if (exiting) return;
      // Winston is ended: do not log after this point.
      exiting = true;
      platform.exit(result !== 'flushed' ? 1 : signal === 'SIGINT' ? 130 : 143);
    } finally {
      clearTimeout(deadline);
      removeListeners();
    }
  };

  const shutdown = (signal: Signal): Promise<void> => {
    shutdownPromise ??= performShutdown(signal);
    return shutdownPromise;
  };
  const handle = (signal: Signal) => {
    void shutdown(signal).catch(() => {
      if (exiting) return;
      exiting = true;
      removeListeners();
      platform.exit(1);
    });
  };
  const onInterrupt = () => handle('SIGINT');
  const onTerminate = () => handle('SIGTERM');
  platform.on('SIGINT', onInterrupt);
  platform.on('SIGTERM', onTerminate);

  return { shutdown, removeListeners };
}
