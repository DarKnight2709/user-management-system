import { describe, expect, it } from 'vitest';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';
import {
  defaultAdminPermissions,
  isDefaultMemberPermission,
} from '../constants/organization.constant.js';

describe('defaultAdminPermissions', () => {
  it('only references permissions in the organization catalog', () => {
    for (const { resource, action } of defaultAdminPermissions) {
      expect(
        organizationPermissions.some(
          (entry) => entry.resource === resource && entry.action === action,
        ),
      ).toBe(true);
    }
  });

  it('never grants role mutation or platform-only permissions by default', () => {
    expect(
      defaultAdminPermissions.filter(
        ({ resource, action }) =>
          resource === 'ORGANIZATION_ROLE' && action !== 'read',
      ),
    ).toEqual([]);
  });
});

describe('isDefaultMemberPermission', () => {
  it('accepts read permissions', () => {
    expect(
      isDefaultMemberPermission({
        resource: 'ORGANIZATION_MEMBER',
        action: 'read',
      }),
    ).toBe(true);
  });

  it('rejects the audit log read permission', () => {
    expect(
      isDefaultMemberPermission({
        resource: 'ORGANIZATION_AUDIT_LOG',
        action: 'read',
      }),
    ).toBe(false);
  });

  it('rejects non-read actions', () => {
    expect(
      isDefaultMemberPermission({
        resource: 'ORGANIZATION',
        action: 'update',
      }),
    ).toBe(false);
  });
});
