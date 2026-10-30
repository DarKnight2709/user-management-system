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

  emitWhen: 'business-change-committed';

  // Lỗi ghi bản chính phải làm transaction thất bại.
  onPersistenceFailure: 'rollback';

  // Lỗi bản sao không thay đổi nghiệp vụ đã commit.
  onLoggingFailure: 'preserve-business-result';
};

export const AUDIT_POLICIES = {
  'organization.member_role.assigned': {
    schemaVersion: 1,
    category: 'audit',

    persistToPostgres: true,
    transaction: 'required',

    output: 'winston-console',
    publishCopy: 'after-commit',

    outcome: 'SUCCESS',
    level: 'info',

    emitWhen: 'business-change-committed',

    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.member_role.revoked': {
    schemaVersion: 1,
    category: 'audit',

    persistToPostgres: true,
    transaction: 'required',

    output: 'winston-console',
    publishCopy: 'after-commit',

    outcome: 'SUCCESS',
    level: 'info',

    emitWhen: 'business-change-committed',

    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.role.created': {
    schemaVersion: 1,
    category: 'audit',

    persistToPostgres: true,
    transaction: 'required',

    output: 'winston-console',
    publishCopy: 'after-commit',

    outcome: 'SUCCESS',
    level: 'info',

    emitWhen: 'business-change-committed',

    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.role.updated': {
    schemaVersion: 1,
    category: 'audit',

    persistToPostgres: true,
    transaction: 'required',

    output: 'winston-console',
    publishCopy: 'after-commit',

    outcome: 'SUCCESS',
    level: 'info',

    emitWhen: 'business-change-committed',

    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.role.deleted': {
    schemaVersion: 1,
    category: 'audit',

    persistToPostgres: true,
    transaction: 'required',

    output: 'winston-console',
    publishCopy: 'after-commit',

    outcome: 'SUCCESS',
    level: 'info',

    emitWhen: 'business-change-committed',

    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.created': {
    schemaVersion: 1,
    category: 'audit',
    persistToPostgres: true,
    transaction: 'required',
    output: 'winston-console',
    publishCopy: 'after-commit',
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'business-change-committed',
    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.updated': {
    schemaVersion: 1,
    category: 'audit',
    persistToPostgres: true,
    transaction: 'required',
    output: 'winston-console',
    publishCopy: 'after-commit',
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'business-change-committed',
    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.deleted': {
    schemaVersion: 1,
    category: 'audit',
    persistToPostgres: true,
    transaction: 'required',
    output: 'winston-console',
    publishCopy: 'after-commit',
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'business-change-committed',
    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
  'organization.ownership.transferred': {
    schemaVersion: 1,
    category: 'audit',
    persistToPostgres: true,
    transaction: 'required',
    output: 'winston-console',
    publishCopy: 'after-commit',
    outcome: 'SUCCESS',
    level: 'info',
    emitWhen: 'business-change-committed',
    onPersistenceFailure: 'rollback',
    onLoggingFailure: 'preserve-business-result',
  },
} as const satisfies Record<AuditEventName, AuditEventPolicy>;
