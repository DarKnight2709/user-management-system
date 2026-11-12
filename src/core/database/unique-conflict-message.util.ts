export const DEFAULT_UNIQUE_CONFLICT_MESSAGE = 'Resource already exists';

/**
 * Client-facing text per unique index. The email message does not say which
 * detail collided, so it is not a lookup for registered emails; usernames and
 * slugs are public identifiers.
 */
const UNIQUE_CONFLICT_MESSAGES: Record<string, string> = {
  users_email_key: 'An account with these details already exists',
  users_username_key: 'Username is already taken',
  organizations_slug_key: 'Organization slug is already taken',
};

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null;
}

function readPath(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (current, key) => (isJsonObject(current) ? current[key] : undefined),
    value,
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

/**
 * With the pg driver adapter, Prisma reports a unique violation as
 * `meta.driverAdapterError.cause.constraint` (the index name, or the column
 * names when the driver gave no index) plus `meta.table`; there is no `meta.target`.
 */
function violatedIndexName(meta: unknown): string | undefined {
  const constraint = readPath(
    meta,
    'driverAdapterError',
    'cause',
    'constraint',
  );
  const index = readPath(constraint, 'index');
  if (typeof index === 'string') return index;

  const fields = readPath(constraint, 'fields');
  const table = readPath(meta, 'table');
  if (isStringArray(fields) && typeof table === 'string') {
    return `${table}_${fields.join('_')}_key`;
  }
  return undefined;
}

/** Stable message for a P2002 error; never contains driver or column wording. */
export function uniqueConflictMessage(meta: unknown): string {
  const index = violatedIndexName(meta);
  return (
    (index !== undefined ? UNIQUE_CONFLICT_MESSAGES[index] : undefined) ??
    DEFAULT_UNIQUE_CONFLICT_MESSAGE
  );
}
