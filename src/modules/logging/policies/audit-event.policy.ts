export type AuditEventName = 'user.role.changed';

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
  'user.role.changed': {
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
