import { randomUUID } from 'node:crypto';
import { requestContext } from '@/core/logging/request-context.js';

export const currentRequestId = (): string =>
  requestContext.getStore()?.requestId ?? randomUUID();
