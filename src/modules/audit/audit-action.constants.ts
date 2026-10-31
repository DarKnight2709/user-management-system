import type { AuditEventName } from '@/modules/logging/types/audit-event.types.js';

export const ORGANIZATION_AUDIT_ACTIONS = [
  'audit.log.viewed',
  'organization.member_role.assigned',
  'organization.member_role.revoked',
  'organization.role.created',
  'organization.role.updated',
  'organization.role.deleted',
  'organization.created',
  'organization.updated',
  'organization.deleted',
  'organization.ownership.transferred',
  'organization.member.removed',
  'organization.member.left',
  'organization.invitation.created',
  'organization.invitation.resend_requested',
  'organization.invitation.revoked',
  'organization.invitation.accepted',
] as const satisfies readonly AuditEventName[];
