/**
 * Upper bound on a login password. Far above the 72-byte limit applied on
 * registration; it only bounds the work done for a hostile request.
 */
export const LOGIN_PASSWORD_MAX_BYTES = 1024;

/** Random bytes behind the dummy password that unknown emails are compared with. */
export const DUMMY_PASSWORD_BYTES = 32;

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Refresh tokens are kept this long after they expire, then deleted. An expired
 * token is rejected before the database is read, so keeping its row is only a
 * buffer for clock skew and a logout that is still in flight.
 */
export const REFRESH_TOKEN_RETENTION_AFTER_EXPIRY_MS = MS_PER_DAY;

export const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = MS_PER_HOUR;

/** Rows deleted per statement, so a large backlog never holds a long lock. */
export const REFRESH_TOKEN_CLEANUP_BATCH_SIZE = 1000;

/** Bounds one run; a larger backlog is finished by the following runs. */
export const REFRESH_TOKEN_CLEANUP_MAX_BATCHES = 20;
