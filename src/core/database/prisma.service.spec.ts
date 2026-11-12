import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client.js';
import {
  MAX_RETRY_DELAY_MS,
  MIN_RETRY_DELAY_MS,
  PrismaService,
} from './prisma.service.js';
import { TransactionConflictException } from './transaction-conflict.exception.js';

function adapterError(code: string): Error {
  const error = new Error('Fixture adapter error', {
    cause: { originalCode: code },
  });
  error.name = 'DriverAdapterError';
  return error;
}

const conflicts = [
  [
    'Prisma P2034',
    () =>
      new Prisma.PrismaClientKnownRequestError('Fixture', {
        code: 'P2034',
        clientVersion: 'test',
      }),
  ],
  ['PostgreSQL serialization failure', () => adapterError('40001')],
  ['PostgreSQL deadlock', () => adapterError('40P01')],
] as const;

const runTransaction = (
  transaction: ReturnType<typeof vi.fn>,
  operation = vi.fn(),
) =>
  PrismaService.prototype.serializableTransaction.call(
    { $transaction: transaction },
    operation,
  );

describe('Serializable transaction retries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(conflicts)(
    'retries %s and returns the successful result',
    async (_, makeError) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce(makeError())
        .mockResolvedValueOnce('committed');
      const operation = vi.fn();

      const result = runTransaction(transaction, operation);
      await vi.runAllTimersAsync();

      await expect(result).resolves.toBe('committed');
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledWith(operation, {
        isolationLevel: 'Serializable',
      });
    },
  );

  it('waits a short random time before retrying', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(conflicts[0][1]())
      .mockResolvedValueOnce('committed');

    const result = runTransaction(transaction);
    await vi.advanceTimersByTimeAsync(MIN_RETRY_DELAY_MS - 1);
    const callsBeforeMinimumDelay = transaction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(MAX_RETRY_DELAY_MS);
    await result;

    expect(callsBeforeMinimumDelay).toBe(1);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  describe.each(conflicts)('when %s persists', (_, makeError) => {
    const exhaustRetries = async () => {
      const error = makeError();
      const transaction = vi.fn().mockRejectedValue(error);
      const outcome = runTransaction(transaction).catch(
        (thrown: unknown) => thrown,
      );
      await vi.runAllTimersAsync();
      return { error, transaction, thrown: await outcome };
    };

    it('stops after three attempts', async () => {
      const { transaction } = await exhaustRetries();

      expect(transaction).toHaveBeenCalledTimes(3);
    });

    it('fails with a retryable 503 instead of the driver error', async () => {
      const { thrown } = await exhaustRetries();

      expect(thrown).toBeInstanceOf(TransactionConflictException);
      expect(thrown).toMatchObject({ status: 503 });
    });

    it('keeps the original error as the cause', async () => {
      const { error, thrown } = await exhaustRetries();

      expect((thrown as Error).cause).toBe(error);
    });
  });

  it.each([
    ['policy denial', new ConflictException('Fixture policy')],
    ['unrelated adapter failure', adapterError('23505')],
    [
      'unwrapped error with a similar cause',
      new Error('Fixture', { cause: { originalCode: '40001' } }),
    ],
    ['unexpected error', new Error('Fixture unexpected failure')],
  ])('does not retry %s', async (_, error) => {
    const transaction = vi.fn().mockRejectedValue(error);

    await expect(runTransaction(transaction)).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
