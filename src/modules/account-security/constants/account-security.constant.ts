import type { UserSecurityTokenType } from '@/generated/prisma/enums.js';

export const ACCOUNT_EMAIL_QUEUE = 'account-email';

/** Emails the worker sends at the same time. */
export const ACCOUNT_EMAIL_WORKER_CONCURRENCY = 3;

const MS_PER_MINUTE = 60 * 1000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export const PASSWORD_RESET_TOKEN_LIFETIME_MS = 30 * MS_PER_MINUTE;
export const EMAIL_VERIFICATION_TOKEN_LIFETIME_MS = MS_PER_DAY;

/** Token length: 32 HMAC-SHA256 bytes in unpadded base64url. */
export const SECURITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Frontend page that receives the token (in the URL fragment) per token type. */
export const SECURITY_TOKEN_LINK_PATHS: Record<UserSecurityTokenType, string> =
  {
    PASSWORD_RESET: 'reset-password',
    EMAIL_VERIFICATION: 'verify-email',
  };

/** Forgot-password limits: per address, and per client IP. */
export const FORGOT_PASSWORD_EMAIL_LIMIT = 3;
export const FORGOT_PASSWORD_EMAIL_WINDOW_MS = MS_PER_HOUR;
export const FORGOT_PASSWORD_IP_LIMIT = 5;
export const RESET_PASSWORD_IP_LIMIT = 10;

/** Email verification limits: opening a link, and asking for another one. */
export const VERIFY_EMAIL_IP_LIMIT = 10;
export const RESEND_VERIFICATION_USER_LIMIT = 3;
export const RESEND_VERIFICATION_WINDOW_MS = MS_PER_HOUR;
export const RESEND_VERIFICATION_IP_LIMIT = 10;

/**
 * Every forgot-password request takes at least this long, so response time does
 * not reveal whether the address belongs to an account.
 */
export const FORGOT_PASSWORD_MIN_DURATION_MS = 500;

export const INVALID_SECURITY_TOKEN_MESSAGE = 'Invalid or expired token';
