import { ServiceUnavailableException } from '@nestjs/common';

export const TRANSACTION_CONFLICT_RETRY_AFTER_SECONDS = 1;

/**
 * A serializable transaction still conflicted with another one after its
 * retries. It was rolled back completely, so the client may safely retry.
 */
export class TransactionConflictException extends ServiceUnavailableException {
  constructor(cause: unknown) {
    super(
      {
        error: 'Service Unavailable',
        message: 'The request conflicted with another operation. Retry later.',
        retryAfterSeconds: TRANSACTION_CONFLICT_RETRY_AFTER_SECONDS,
      },
      { cause },
    );
  }
}
