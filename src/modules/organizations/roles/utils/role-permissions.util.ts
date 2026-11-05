import { catalogPermissionFilter } from '../constants/organization-role.constant.js';
import type {
  PermissionKey,
  RolePermission,
} from '../interfaces/organization-roles.interface.js';

export const isCatalogPermission = (permission: PermissionKey): boolean =>
  catalogPermissionFilter.some(
    ({ resource, action }) =>
      resource === permission.resource && action === permission.action,
  );

// The organization audit permission is reserved for built-in ADMIN roles.
export const isAssignablePermission = (permission: PermissionKey): boolean =>
  isCatalogPermission(permission) &&
  !(
    permission.resource === 'ORGANIZATION_AUDIT_LOG' &&
    permission.action === 'read'
  );

export const toAuditPermissions = (permissions: RolePermission[]) =>
  permissions.map(({ id, resource, action }) => ({ id, resource, action }));

export const hasSameIds = (
  currentIds: string[],
  requestedIds: string[],
): boolean => {
  if (currentIds.length !== requestedIds.length) return false;
  const current = [...currentIds].sort();
  const requested = [...requestedIds].sort();
  return current.every((id, index) => id === requested[index]);
};
