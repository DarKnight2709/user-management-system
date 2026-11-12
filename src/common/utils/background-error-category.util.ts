import { Prisma } from '@/generated/prisma/client.js';
import type { BackgroundErrorCategory } from '@/modules/logging/types/application-event.types.js';

/** Safe, fixed label for a background-task failure; never the error itself. */
export function backgroundErrorCategory(
  error: unknown,
): BackgroundErrorCategory {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    error instanceof Prisma.PrismaClientUnknownRequestError ||
    error instanceof Prisma.PrismaClientInitializationError ||
    error instanceof Prisma.PrismaClientValidationError
  ) {
    return 'database';
  }
  if (!(error instanceof Error)) return 'unknown';
  switch (error.name) {
    case 'AbortError':
    case 'TimeoutError':
      return 'timeout';
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
      return 'storage_authorization';
    case 'NoSuchBucket':
      return 'storage_bucket_missing';
    case 'SlowDown':
    case 'ServiceUnavailable':
      return 'storage_unavailable';
    default:
      return 'unknown';
  }
}
