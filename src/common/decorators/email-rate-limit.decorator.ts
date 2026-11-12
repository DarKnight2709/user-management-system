import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

export const EMAIL_RATE_LIMIT_KEY = 'emailAccountRateLimit';

/** Limits requests per email address in the body, whether or not it has an account. */
export const EmailRateLimit = (limit: number, ttl: number = 60_000) =>
  applyDecorators(
    SetMetadata(EMAIL_RATE_LIMIT_KEY, true),
    Throttle({ account: { limit, ttl } }),
  );
