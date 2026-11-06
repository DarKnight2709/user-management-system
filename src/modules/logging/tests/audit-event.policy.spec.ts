import { describe, expect, it } from 'vitest';
import { AUDIT_POLICIES } from '../policies/audit-event.policy.js';

describe('AUDIT_POLICIES', () => {
  const entries = Object.entries(AUDIT_POLICIES);

  it('catalogues the audit actions the application emits', () => {
    expect(Object.keys(AUDIT_POLICIES)).toEqual(
      expect.arrayContaining([
        'audit.log.viewed',
        'user.registered',
        'user.profile.updated',
        'user.deleted',
        'organization.deleted',
      ]),
    );
  });

  it.each(entries)(
    '%s is stored first and copied after commit',
    (_, policy) => {
      expect(policy).toMatchObject({
        schemaVersion: 1,
        category: 'audit',
        persistToPostgres: true,
        transaction: 'required',
        output: 'winston-console',
        publishCopy: 'after-commit',
        outcome: 'SUCCESS',
        level: 'info',
        onPersistenceFailure: 'rollback',
        onLoggingFailure: 'preserve-business-result',
      });
    },
  );

  it('marks only audit log reads as sensitive reads', () => {
    const sensitive = entries
      .filter(([, policy]) => policy.emitWhen === 'sensitive-audit-data-read')
      .map(([action]) => action);

    expect(sensitive).toEqual(['audit.log.viewed']);
    for (const [action, policy] of entries) {
      if (action !== 'audit.log.viewed') {
        expect(policy.emitWhen).toBe('business-change-committed');
      }
    }
  });
});
