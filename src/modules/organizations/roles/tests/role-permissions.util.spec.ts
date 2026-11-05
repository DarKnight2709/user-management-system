import { describe, expect, it } from 'vitest';
import {
  hasSameIds,
  isAssignablePermission,
  isCatalogPermission,
  toAuditPermissions,
} from '../utils/role-permissions.util.js';

describe('isCatalogPermission', () => {
  it('accepts an organization catalog entry', () => {
    expect(
      isCatalogPermission({ resource: 'ORGANIZATION_ROLE', action: 'read' }),
    ).toBe(true);
  });

  it('rejects platform-only permissions', () => {
    expect(
      isCatalogPermission({ resource: 'ORGANIZATION', action: 'delete' }),
    ).toBe(false);
  });

  it('rejects a known resource with an unknown action', () => {
    expect(
      isCatalogPermission({ resource: 'ORGANIZATION_ROLE', action: 'archive' }),
    ).toBe(false);
  });
});

describe('isAssignablePermission', () => {
  it('accepts an ordinary catalog entry', () => {
    expect(
      isAssignablePermission({
        resource: 'ORGANIZATION_MEMBER',
        action: 'invite',
      }),
    ).toBe(true);
  });

  it('rejects the organization audit read permission', () => {
    expect(
      isAssignablePermission({
        resource: 'ORGANIZATION_AUDIT_LOG',
        action: 'read',
      }),
    ).toBe(false);
  });

  it('rejects entries outside the catalog', () => {
    expect(isAssignablePermission({ resource: 'USER', action: 'read' })).toBe(
      false,
    );
  });
});

describe('hasSameIds', () => {
  it('ignores ordering', () => {
    expect(hasSameIds(['b', 'a'], ['a', 'b'])).toBe(true);
  });

  it('treats two empty lists as equal', () => {
    expect(hasSameIds([], [])).toBe(true);
  });

  it('detects a different length', () => {
    expect(hasSameIds(['a'], ['a', 'b'])).toBe(false);
  });

  it('detects a replaced id', () => {
    expect(hasSameIds(['a', 'b'], ['a', 'c'])).toBe(false);
  });

  it('does not mutate its inputs', () => {
    const current = ['b', 'a'];
    hasSameIds(current, ['a', 'b']);
    expect(current).toEqual(['b', 'a']);
  });
});

describe('toAuditPermissions', () => {
  it('keeps only identifying fields', () => {
    expect(
      toAuditPermissions([
        { id: 'p1', resource: 'R', action: 'a', description: 'text' },
      ]),
    ).toEqual([{ id: 'p1', resource: 'R', action: 'a' }]);
  });
});
