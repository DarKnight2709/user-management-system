/** Longest email address allowed by RFC 5321. */
export const EMAIL_MAX_LENGTH = 254;

export const NAME_MAX_LENGTH = 100;

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 32;
/** Lowercase letters and digits, optionally joined by dots, underscores or hyphens. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Anyone older than this is treated as a data-entry error. */
export const MAX_AGE_YEARS = 150;

export const PASSWORD_MIN_LENGTH = 15;
/** bcrypt ignores everything after 72 bytes. */
export const PASSWORD_MAX_BYTES = 72;
