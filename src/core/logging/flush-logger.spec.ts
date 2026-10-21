import { describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger, format, transports } from 'winston';
import { flushLogger } from './flush-logger.js';

describe('Bounded logger flush', () => {
  it('handles output write errors without an unhandled stream error', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('Fixture output failure'));
      },
    });
    const logger = createLogger({ transports: [new transports.Console()] });
    await expect(flushLogger(logger, { outputs: [output] })).resolves.toBe(
      'failed',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(output.listenerCount('error')).toBe(0);
    logger.close();
  });

  it('waits for queued output after Winston finish without ending the output stream', async () => {
    const writes: (() => void)[] = [];
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        writes.push(callback);
      },
    });
    const logger = createLogger({
      format: format.json(),
      transports: [new transports.Stream({ stream: output })],
    });
    logger.info('Final fixture record');
    let completed = false;
    const loggerFinished = new Promise<void>((resolve) =>
      logger.once('finish', resolve),
    );
    const result = flushLogger(logger, { outputs: [output] }).then((value) => {
      completed = true;
      return value;
    });
    await loggerFinished;
    expect(completed).toBe(false);
    expect(writes).toHaveLength(1);
    writes[0]();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(completed).toBe(false);
    writes[1]();
    await expect(result).resolves.toBe('flushed');
    expect(output.writableEnded).toBe(false);
    expect(output.listenerCount('error')).toBe(0);
    logger.close();
    output.destroy();
  });

  it('times out rather than waiting forever for output', async () => {
    const output = new Writable({ write() {} });
    const logger = createLogger({ transports: [new transports.Console()] });
    await expect(
      flushLogger(logger, { outputs: [output], timeoutMs: 20 }),
    ).resolves.toBe('timeout');
    expect(logger.listenerCount('finish')).toBe(0);
    expect(output.listenerCount('error')).toBe(0);
    logger.close();
    output.destroy();
  });

  it('reports a destroyed output as failed without throwing or ending other streams', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    output.destroy();
    const logger = createLogger({ transports: [new transports.Console()] });
    await expect(flushLogger(logger, { outputs: [output] })).resolves.toBe(
      'failed',
    );
    logger.close();
  });

  it('can drain an already finished logger and does not call end again', async () => {
    const logger = createLogger({ transports: [new transports.Console()] });
    await new Promise<void>((resolve) => {
      logger.once('finish', resolve);
      logger.end();
    });
    const end = vi.spyOn(logger, 'end');
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    await expect(flushLogger(logger, { outputs: [output] })).resolves.toBe(
      'flushed',
    );
    expect(end).not.toHaveBeenCalled();
    logger.close();
    output.destroy();
  });
});
