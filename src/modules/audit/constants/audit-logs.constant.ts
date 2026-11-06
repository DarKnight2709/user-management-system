import type { Prisma } from '@/generated/prisma/client.js';

/** Newest first; eventId breaks ties so pages never overlap. */
export const AUDIT_EVENT_ORDER = [
  { occurredAt: 'desc' },
  { eventId: 'desc' },
] satisfies Prisma.AuditEventOrderByWithRelationInput[];

export const PLATFORM_AUDIT_PERMISSION = {
  resource: 'AUDIT_LOG',
  action: 'read',
} as const;

export const ORGANIZATION_AUDIT_PERMISSION = {
  resource: 'ORGANIZATION_AUDIT_LOG',
  action: 'read',
} as const;

export const PLATFORM_AUDIT_DENIED_MESSAGE = 'Audit access denied';
export const ORGANIZATION_AUDIT_DENIED_MESSAGE =
  'Organization audit access denied';

/** The built-in local role allowed to read organization audit history. */
export const BUILT_IN_ADMIN_ROLE_NAME = 'ADMIN';
