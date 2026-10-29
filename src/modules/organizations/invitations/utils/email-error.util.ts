// Never include error.message, stack, response text, or arbitrary properties.
import type { SafeEmailErrorCode } from '@/modules/logging/types/application-event.types.js';

const safeCodes = new Set<Exclude<SafeEmailErrorCode, 'UNKNOWN'>>([
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

export function safeEmailErrorDetails(error: unknown): {
  code: SafeEmailErrorCode;
  responseCode?: number;
} {
  if (typeof error !== 'object' || error === null) return { code: 'UNKNOWN' };
  const code =
    'code' in error &&
    typeof error.code === 'string' &&
    safeCodes.has(error.code as Exclude<SafeEmailErrorCode, 'UNKNOWN'>)
      ? (error.code as Exclude<SafeEmailErrorCode, 'UNKNOWN'>)
      : 'UNKNOWN';
  const responseCode =
    'responseCode' in error &&
    typeof error.responseCode === 'number' &&
    Number.isInteger(error.responseCode) &&
    error.responseCode >= 400 &&
    error.responseCode <= 599
      ? error.responseCode
      : undefined;
  return responseCode === undefined ? { code } : { code, responseCode };
}
