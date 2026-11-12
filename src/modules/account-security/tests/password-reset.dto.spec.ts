import { describe, expect, it } from 'vitest';
import { EMAIL_MAX_LENGTH } from '@/common/constants/account-field.constant.js';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { emailOfLength } from '../../../../test/support/email-of-length.js';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
} from '../dto/password-reset.dto.js';

const VALID_TOKEN = 'A'.repeat(43);
const VALID_PASSWORD = 'a-brand-new-password';

const validateForgot = (body: unknown) =>
  new InputValidationPipe().transform(body, {
    type: 'body',
    metatype: ForgotPasswordDto,
  });

const validateReset = (body: unknown) =>
  new InputValidationPipe().transform(body, {
    type: 'body',
    metatype: ResetPasswordDto,
  });

describe('ForgotPasswordDto', () => {
  it('trims and lowercases the address', async () => {
    await expect(
      validateForgot({ email: '  Alice@Example.COM ' }),
    ).resolves.toMatchObject({ email: 'alice@example.com' });
  });

  it('accepts an address of the maximum length', async () => {
    await expect(
      validateForgot({ email: emailOfLength(EMAIL_MAX_LENGTH) }),
    ).resolves.toBeDefined();
  });

  it.each([
    ['missing', {}],
    ['not an address', { email: 'not-an-email' }],
    ['empty', { email: '' }],
    ['a number', { email: 12345 }],
    ['an object', { email: { a: 1 } }],
    ['over the maximum length', { email: emailOfLength(EMAIL_MAX_LENGTH + 1) }],
    ['sent with an unexpected field', { email: 'a@example.com', admin: true }],
  ])('rejects an email that is %s with 422', async (_, body) => {
    await expect(validateForgot(body)).rejects.toMatchObject({ status: 422 });
  });
});

describe('ResetPasswordDto', () => {
  it('accepts a token and a new password', async () => {
    await expect(
      validateReset({ token: VALID_TOKEN, newPassword: VALID_PASSWORD }),
    ).resolves.toMatchObject({ token: VALID_TOKEN });
  });

  it('accepts every base64url character in a token', async () => {
    const token = `${'a-_Z09'.repeat(7)}a`;

    await expect(
      validateReset({ token, newPassword: VALID_PASSWORD }),
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
    await expect(
      validateReset({ token, newPassword: VALID_PASSWORD }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it.each([
    ['too short', 'short'],
    ['only spaces', ' '.repeat(20)],
    ['a number', 123456789012345],
    ['missing', undefined],
  ])('rejects a new password that is %s with 422', async (_, newPassword) => {
    await expect(
      validateReset({ token: VALID_TOKEN, newPassword }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('rejects unexpected fields', async () => {
    await expect(
      validateReset({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
        userId: 'someone-else',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
