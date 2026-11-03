import type { SafeEmailErrorCode } from '@/modules/logging/types/application-event.types.js';

type KnownSafeEmailErrorCode = Exclude<SafeEmailErrorCode, 'UNKNOWN'>;

type SafeEmailErrorDetails = {
  code: SafeEmailErrorCode;
  responseCode?: number;
};

const SAFE_EMAIL_ERROR_CODES = new Set<KnownSafeEmailErrorCode>([
  'EDNS',
  'EAUTH',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNECTION',
  'ETLS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENODATA',
  'ETIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EENVELOPE',
  'EMESSAGE',
  'P1001',
  'P1002',
  'P1008',
  'P2024',
  'P2025',
  'P2034',
]);

// Never expose raw error details, including messages, stacks, or SMTP responses.
export function safeEmailErrorDetails(
  error: unknown,
): SafeEmailErrorDetails {
  if (!isErrorRecord(error)) {
    return { code: 'UNKNOWN' };
  }

  const code = getSafeErrorCode(error);
  const responseCode = getSafeResponseCode(error);

  return responseCode === undefined ? { code } : { code, responseCode };
}

function getSafeErrorCode(error: Record<string, unknown>): SafeEmailErrorCode {
  if (
    typeof error.code !== 'string' ||
    !SAFE_EMAIL_ERROR_CODES.has(error.code as KnownSafeEmailErrorCode)
  ) {
    return 'UNKNOWN';
  }

  return error.code as KnownSafeEmailErrorCode;
}

function getSafeResponseCode(
  error: Record<string, unknown>,
): number | undefined {
  if (
    typeof error.responseCode !== 'number' ||
    !Number.isInteger(error.responseCode) ||
    error.responseCode < 400 ||
    error.responseCode > 599
  ) {
    return undefined;
  }

  return error.responseCode;
}

function isErrorRecord(error: unknown): error is Record<string, unknown> {
  return typeof error === 'object' && error !== null;
}
