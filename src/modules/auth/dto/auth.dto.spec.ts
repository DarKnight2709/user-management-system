import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_LENGTH,
} from '@/common/constants/account-field.constant.js';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { ChangePasswordDto } from './change-password.dto.js';
import { RegisterDto } from './auth.dto.js';

const VALID_PASSWORD = 'correct-password-123';

const validateRegistration = (overrides: Record<string, unknown> = {}) =>
  new InputValidationPipe().transform(
    {
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Doe',
      email: 'alice@example.com',
      birthDate: '2000-01-01',
      password: VALID_PASSWORD,
      ...overrides,
    },
    { type: 'body', metatype: RegisterDto },
  );

const validatePasswordChange = (overrides: Record<string, unknown> = {}) =>
  new InputValidationPipe().transform(
    {
      currentPassword: 'old-password-123',
      newPassword: VALID_PASSWORD,
      ...overrides,
    },
    { type: 'body', metatype: ChangePasswordDto },
  );

const validPasswords = [
  ['the minimum length', 'a'.repeat(PASSWORD_MIN_LENGTH)],
  ['the maximum size', 'a'.repeat(PASSWORD_MAX_BYTES)],
  ['mostly spaces around one visible character', `a${' '.repeat(14)}`],
  ['a multi-byte password within the byte limit', 'é'.repeat(36)],
] as const;

const invalidPasswords = [
  ['one character short', 'a'.repeat(PASSWORD_MIN_LENGTH - 1)],
  ['one byte over the maximum size', 'a'.repeat(PASSWORD_MAX_BYTES + 1)],
  ['only spaces', ' '.repeat(PASSWORD_MIN_LENGTH)],
  ['only tabs and newlines', '\t\n'.repeat(PASSWORD_MIN_LENGTH)],
  ['a multi-byte password over the byte limit', 'é'.repeat(37)],
  ['a number', 123456789012345],
  ['empty', ''],
] as const;

describe.each([
  ['registration password', 'password', validateRegistration],
  ['new password', 'newPassword', validatePasswordChange],
] as const)('%s', (_, field, validate) => {
  it.each(validPasswords)('accepts %s', async (__, password) => {
    await expect(validate({ [field]: password })).resolves.toBeDefined();
  });

  it.each(invalidPasswords)('rejects %s', async (__, password) => {
    await expect(validate({ [field]: password })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('RegisterDto', () => {
  it('applies the shared profile rules', async () => {
    await expect(
      validateRegistration({ firstName: '   ' }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('normalizes username and email like a profile update', async () => {
    await expect(
      validateRegistration({
        username: ' Alice ',
        email: ' Alice@Example.COM ',
      }),
    ).resolves.toMatchObject({
      username: 'alice',
      email: 'alice@example.com',
    });
  });
});

describe('ChangePasswordDto', () => {
  it('requires the current password', async () => {
    await expect(
      validatePasswordChange({ currentPassword: '' }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
