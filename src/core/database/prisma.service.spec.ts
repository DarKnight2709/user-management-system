import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from './prisma.service.js';

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

describe('Serializable transaction retries', () => {
  it.each(conflicts)(
    'retries %s and returns the successful result',
    async (_, makeError) => {
      const transaction = vi
        .fn()
        .mockRejectedValueOnce(makeError())
        .mockResolvedValueOnce('committed');
      const operation = vi.fn();
      await expect(
        PrismaService.prototype.serializableTransaction.call(
          { $transaction: transaction },
          operation,
        ),
      ).resolves.toBe('committed');
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenCalledWith(operation, {
        isolationLevel: 'Serializable',
      });
    },
  );

  it.each(conflicts)(
    'stops after three attempts for %s',
    async (_, makeError) => {
      const error = makeError();
      const transaction = vi.fn().mockRejectedValue(error);
      await expect(
        PrismaService.prototype.serializableTransaction.call(
          { $transaction: transaction },
          vi.fn(),
        ),
      ).rejects.toBe(error);
      expect(transaction).toHaveBeenCalledTimes(3);
    },
  );

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
    await expect(
      PrismaService.prototype.serializableTransaction.call(
        { $transaction: transaction },
        vi.fn(),
      ),
    ).rejects.toBe(error);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
