import { isWritable, type Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { Logger } from 'winston';

export type FlushResult = 'flushed' | 'failed' | 'timeout';

// Call after app.close(): no service or worker should still produce logs.
export async function flushLogger(
  logger: Logger,
  {
    timeoutMs = 2_000,
    outputs = [process.stdout, process.stderr],
  }: { timeoutMs?: number; outputs?: readonly Writable[] } = {},
): Promise<FlushResult> {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  let result: FlushResult = 'failed';
  let timer: ReturnType<typeof setTimeout>;

  const flush = async (): Promise<FlushResult> => {
    // 1. Stop Winston and wait for its transports.
    const done = finished(logger, {
      readable: false,
      cleanup: true,
      signal: controller.signal,
    });
    if (isWritable(logger)) logger.end();
    await done;

    // 2. Wait for earlier stdout/stderr writes, without ending those streams.
    await Promise.all(
      [...new Set(outputs)].map((output) => waitForOutput(output, cleanups)),
    );
    return 'flushed';
  };
  const deadline = new Promise<FlushResult>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  try {
    // 3. Stop waiting if the deadline wins.
    result = await Promise.race([
      flush().catch(() => 'failed' as const),
      deadline,
    ]);
    return result;
  } finally {
    clearTimeout(timer!);
    controller.abort();
    const cleanup = () => {
      for (const dispose of cleanups) dispose();
    };
    // A failed write callback can precede its stream's error event.
    if (result === 'failed') setImmediate(cleanup);
    else cleanup();
  }
}

function waitForOutput(
  output: Writable,
  cleanups: (() => void)[],
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (output.destroyed || output.writableEnded) {
      reject(new Error('Output stream is unavailable'));
      return;
    }
    const onError = (error: Error) => reject(error);
    output.on('error', onError);
    cleanups.push(() => output.removeListener('error', onError));
    // The callback runs after earlier queued writes have completed.
    output.write('', (error?: Error | null) =>
      error ? reject(error) : resolve(),
    );
  });
}
