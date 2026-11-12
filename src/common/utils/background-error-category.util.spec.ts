import { describe, expect, it } from 'vitest';
import { Prisma } from '@/generated/prisma/client.js';
import { backgroundErrorCategory } from './background-error-category.util.js';

const namedError = (name: string) => Object.assign(new Error('x'), { name });

describe('backgroundErrorCategory', () => {
  it.each([
    [
      'a known Prisma error',
      new Prisma.PrismaClientKnownRequestError('x', {
        code: 'P2002',
        clientVersion: 'fixture',
      }),
    ],
    [
      'a Prisma initialization error',
      new Prisma.PrismaClientInitializationError('x', 'fixture'),
    ],
    [
      'a Prisma validation error',
      new Prisma.PrismaClientValidationError('x', { clientVersion: 'fixture' }),
    ],
  ])('labels %s as database', (_, error) => {
    expect(backgroundErrorCategory(error)).toBe('database');
  });

  it.each([
    ['AbortError', 'timeout'],
    ['TimeoutError', 'timeout'],
    ['AccessDenied', 'storage_authorization'],
    ['InvalidAccessKeyId', 'storage_authorization'],
    ['SignatureDoesNotMatch', 'storage_authorization'],
    ['NoSuchBucket', 'storage_bucket_missing'],
    ['SlowDown', 'storage_unavailable'],
    ['ServiceUnavailable', 'storage_unavailable'],
  ])('labels an error named %s as %s', (name, category) => {
    expect(backgroundErrorCategory(namedError(name))).toBe(category);
  });

  it('labels an unrecognized error as unknown', () => {
    expect(backgroundErrorCategory(new Error('anything'))).toBe('unknown');
  });

  it.each([
    ['a string', 'failure'],
    ['null', null],
    ['undefined', undefined],
    ['an object', { name: 'AbortError' }],
  ])('labels %s that is not an Error as unknown', (_, value) => {
    expect(backgroundErrorCategory(value)).toBe('unknown');
  });
});
