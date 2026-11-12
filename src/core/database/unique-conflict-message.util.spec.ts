import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UNIQUE_CONFLICT_MESSAGE,
  uniqueConflictMessage,
} from './unique-conflict-message.util.js';

const adapterMeta = (
  constraint: unknown,
  table?: string,
): Record<string, unknown> => ({
  driverAdapterError: {
    cause: { kind: 'UniqueConstraintViolation', constraint, table },
  },
  ...(table === undefined ? {} : { table }),
});

describe('uniqueConflictMessage', () => {
  it.each([
    ['users_email_key', 'An account with these details already exists'],
    ['users_username_key', 'Username is already taken'],
    ['organizations_slug_key', 'Organization slug is already taken'],
  ])('describes the %s index', (index, message) => {
    expect(uniqueConflictMessage(adapterMeta({ index }))).toBe(message);
  });

  it('rebuilds the index name from table and columns when the driver gave no index', () => {
    expect(
      uniqueConflictMessage(adapterMeta({ fields: ['username'] }, 'users')),
    ).toBe('Username is already taken');
  });

  it.each([
    ['an unknown index', adapterMeta({ index: 'roles_global_name_key' })],
    ['columns without a table', adapterMeta({ fields: ['email'] })],
    ['a foreign key constraint', adapterMeta({ foreignKey: {} })],
    ['no constraint', adapterMeta(undefined)],
    ['an index that is not a string', adapterMeta({ index: 42 })],
    ['columns that are not strings', adapterMeta({ fields: [1] }, 'users')],
    ['empty metadata', {}],
    ['missing metadata', undefined],
    ['null metadata', null],
    ['a legacy target without the adapter details', { target: ['email'] }],
  ])('falls back to the generic message for %s', (_, meta) => {
    expect(uniqueConflictMessage(meta)).toBe(DEFAULT_UNIQUE_CONFLICT_MESSAGE);
  });

  it('never repeats the index name or table in the message', () => {
    const message = uniqueConflictMessage(
      adapterMeta({ index: 'private_index' }, 'private_table'),
    );

    expect(message).not.toContain('private_');
  });
});
