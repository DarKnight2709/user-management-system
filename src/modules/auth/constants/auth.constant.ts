/**
 * Upper bound on a login password. Far above the 72-byte limit applied on
 * registration; it only bounds the work done for a hostile request.
 */
export const LOGIN_PASSWORD_MAX_BYTES = 1024;

/** Random bytes behind the dummy password that unknown emails are compared with. */
export const DUMMY_PASSWORD_BYTES = 32;
