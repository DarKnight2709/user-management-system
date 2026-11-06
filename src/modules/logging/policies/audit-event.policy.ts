import type { AuditEventName } from '../types/audit-event.types.js';

type AuditEventPolicy = {
  schemaVersion: 1;
  category: 'audit';

  // PostgreSQL là bản chính.
  persistToPostgres: true;
  transaction: 'required';

  // Bản sao đi qua Winston -> Docker -> Alloy -> Loki.
  output: 'winston-console';
  publishCopy: 'after-commit';

  outcome: 'SUCCESS';
  level: 'info';

  emitWhen: 'business-change-committed' | 'sensitive-audit-data-read';

  // Lỗi ghi bản chính phải làm transaction thất bại.
  onPersistenceFailure: 'rollback';

  // Lỗi bản sao không thay đổi nghiệp vụ đã commit.
  onLoggingFailure: 'preserve-business-result';
};

/** Every audit event is stored in PostgreSQL first and copied to Winston after commit. */
const auditPolicy = <E extends AuditEventPolicy['emitWhen']>(emitWhen: E) =>
  ({
    schemaVersion: 1,
    category: 'audit',
    persistToPostgres: true,
    transaction: 'required',
    output: 'winston-console',
    publishCopy: 'after-commit',
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen,
    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  }) as const;

const businessChange = auditPolicy('business-change-committed');
const sensitiveRead = auditPolicy('sensitive-audit-data-read');

export const AUDIT_POLICIES = {
  'audit.log.viewed': sensitiveRead,
  'user.registered': businessChange,
  'user.profile.updated': businessChange,
  'user.deleted': businessChange,
  'user.password.changed': businessChange,
  'user.avatar.updated': businessChange,
  'organization.member_role.assigned': businessChange,
  'organization.member_role.revoked': businessChange,
  'organization.role.created': businessChange,
  'organization.role.updated': businessChange,
  'organization.role.deleted': businessChange,
  'organization.created': businessChange,
  'organization.updated': businessChange,
  'organization.status.changed': businessChange,
  'organization.deleted': businessChange,
  'organization.ownership.transferred': businessChange,
  'organization.member.removed': businessChange,
  'organization.member.left': businessChange,
  'organization.invitation.created': businessChange,
  'organization.invitation.resend_requested': businessChange,
  'organization.invitation.revoked': businessChange,
  'organization.invitation.accepted': businessChange,
} as const satisfies Record<AuditEventName, AuditEventPolicy>;
