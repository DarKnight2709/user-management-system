import { currentRequestId } from '@/common/utils/request-id.util.js';

/** Request metadata attached to every auth security and application event. */
export function authRequestContext(sourceIp?: string, userAgent?: string) {
  return { requestId: currentRequestId(), sourceIp, userAgent };
}
