import { describe, expect, it } from 'vitest';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { VerifyEmailDto } from '../dto/verify-email.dto.js';

const VALID_TOKEN = 'A'.repeat(43);

const validate = (body: unknown) =>
  new InputValidationPipe().transform(body, {
    type: 'body',
    metatype: VerifyEmailDto,
  });

describe('VerifyEmailDto', () => {
  it('accepts a token', async () => {
    await expect(validate({ token: VALID_TOKEN })).resolves.toMatchObject({
      token: VALID_TOKEN,
    });
  });

  it('accepts every base64url character', async () => {
    await expect(
      validate({ token: `${'a-_Z09'.repeat(7)}a` }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['one character short', 'A'.repeat(42)],
    ['one character long', 'A'.repeat(44)],
    ['containing a space', `${'A'.repeat(42)} `],
    ['containing a padding sign', `${'A'.repeat(42)}=`],
    ['a number', 42],
    ['an object', { a: 1 }],
  ])('rejects a token that is %s with 422', async (_, token) => {
    await expect(validate({ token })).rejects.toMatchObject({ status: 422 });
  });

  it('rejects unexpected fields', async () => {
    await expect(
      validate({ token: VALID_TOKEN, userId: 'someone-else' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
