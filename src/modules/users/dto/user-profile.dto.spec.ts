import { describe, expect, it } from 'vitest';
import {
  EMAIL_MAX_LENGTH,
  MAX_AGE_YEARS,
  NAME_MAX_LENGTH,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from '@/common/constants/account-field.constant.js';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { yearsAgo } from '@/common/utils/date.util.js';
import { emailOfLength } from '../../../../test/support/email-of-length.js';
import { UpdateUserDto } from './user.dto.js';

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dayRelativeTo(start: Date, days: number): string {
  const date = new Date(start);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDay(date);
}

const today = () => dayRelativeTo(new Date(), 0);
const daysFromToday = (days: number) => dayRelativeTo(new Date(), days);
// Midnight of the oldest allowed day is earlier than the cut-off, so the day
// after it is the first date that is accepted.
const daysFromCutoff = (days: number) =>
  dayRelativeTo(yearsAgo(MAX_AGE_YEARS), days);

const validProfile = {
  username: 'alice',
  firstName: 'Alice',
  lastName: 'Doe',
  email: 'alice@example.com',
  birthDate: '2000-01-01',
};

const validate = (overrides: Record<string, unknown> = {}) =>
  new InputValidationPipe().transform(
    { ...validProfile, ...overrides },
    { type: 'body', metatype: UpdateUserDto },
  );

describe('User profile validation', () => {
  it('accepts a valid profile', async () => {
    await expect(validate()).resolves.toMatchObject({
      username: 'alice',
      firstName: 'Alice',
      lastName: 'Doe',
      email: 'alice@example.com',
    });
  });

  describe.each(['firstName', 'lastName'])('%s', (field) => {
    it('is trimmed', async () => {
      await expect(validate({ [field]: '  Alice  ' })).resolves.toMatchObject({
        [field]: 'Alice',
      });
    });

    it.each([
      ['empty', ''],
      ['only whitespace', '   \t '],
      ['over the maximum length', 'a'.repeat(NAME_MAX_LENGTH + 1)],
      ['containing a newline', 'Alice\nDoe'],
      ['containing a control character', 'Ali\u0000ce'],
      ['a number', 12345],
      ['an object', { a: 1 }],
      ['null', null],
    ])('rejects a value that is %s', async (_, value) => {
      await expect(validate({ [field]: value })).rejects.toMatchObject({
        status: 422,
      });
    });

    it('accepts the maximum length', async () => {
      await expect(
        validate({ [field]: 'a'.repeat(NAME_MAX_LENGTH) }),
      ).resolves.toBeDefined();
    });

    it('accepts non-latin names', async () => {
      await expect(
        validate({ [field]: 'Nguyễn Thị Ánh' }),
      ).resolves.toBeDefined();
    });
  });

  describe('username', () => {
    it('is trimmed and lowercased', async () => {
      await expect(
        validate({ username: '  Alice.Doe ' }),
      ).resolves.toMatchObject({ username: 'alice.doe' });
    });

    it.each([
      ['the minimum length', 'a'.repeat(USERNAME_MIN_LENGTH)],
      ['the maximum length', 'a'.repeat(USERNAME_MAX_LENGTH)],
      ['dots, underscores and hyphens', 'a.b_c-d'],
      ['digits first', '1alice'],
    ])('accepts %s', async (_, username) => {
      await expect(validate({ username })).resolves.toBeDefined();
    });

    it.each([
      ['below the minimum length', 'a'.repeat(USERNAME_MIN_LENGTH - 1)],
      ['above the maximum length', 'a'.repeat(USERNAME_MAX_LENGTH + 1)],
      ['empty', ''],
      ['containing a space', 'alice doe'],
      ['containing an at sign', 'alice@doe'],
      ['starting with a dot', '.alice'],
      ['starting with a hyphen', '-alice'],
      ['containing a newline', 'alice\ndoe'],
      ['a number', 12345],
      ['an object', { a: 1 }],
    ])('rejects a value that is %s', async (_, username) => {
      await expect(validate({ username })).rejects.toMatchObject({
        status: 422,
      });
    });
  });

  describe('email', () => {
    it('is trimmed and lowercased', async () => {
      await expect(
        validate({ email: '  Alice@Example.COM ' }),
      ).resolves.toMatchObject({ email: 'alice@example.com' });
    });

    it('accepts the maximum length', async () => {
      await expect(
        validate({ email: emailOfLength(EMAIL_MAX_LENGTH) }),
      ).resolves.toBeDefined();
    });

    it.each([
      [
        'one character over the maximum length',
        emailOfLength(EMAIL_MAX_LENGTH + 1),
      ],
      ['not an email', 'not-an-email'],
      ['empty', ''],
      ['a number', 12345],
      ['an object', { a: 1 }],
    ])('rejects a value that is %s', async (_, email) => {
      await expect(validate({ email })).rejects.toMatchObject({ status: 422 });
    });
  });

  describe('birth date', () => {
    it.each([
      ['today', today()],
      ['yesterday', daysFromToday(-1)],
      ['the first day after the age cut-off', daysFromCutoff(1)],
    ])('accepts %s', async (_, birthDate) => {
      await expect(validate({ birthDate })).resolves.toBeDefined();
    });

    it.each([
      ['tomorrow', daysFromToday(1)],
      ['a future year', '2999-01-01'],
      ['the day before the age cut-off', daysFromCutoff(-1)],
      ['a very old date', '1800-01-01'],
      ['not a date', 'not-a-date'],
      ['empty', ''],
      ['an object', { a: 1 }],
    ])('rejects %s', async (_, birthDate) => {
      await expect(validate({ birthDate })).rejects.toMatchObject({
        status: 422,
      });
    });
  });

  it('rejects unexpected fields', async () => {
    await expect(validate({ hashedPassword: 'x' })).rejects.toMatchObject({
      status: 422,
    });
  });
});
