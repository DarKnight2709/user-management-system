import type { Prisma } from '@/generated/prisma/client.js';
import { organizationPermissions } from '@/common/constants/organization-permissions.constant.js';

export const OWNER_ROLE_NAME = 'OWNER';
export const BUILT_IN_ROLE_NAMES = ['ADMIN', 'MEMBER'] as const;
export const RESERVED_ROLE_NAMES = [
  OWNER_ROLE_NAME,
  ...BUILT_IN_ROLE_NAMES,
] as const;

export const catalogPermissionFilter = organizationPermissions.map(
  ({ resource, action }) => ({ resource, action }),
);

export const permissionDetailsSelect = {
  id: true,
  resource: true,
  action: true,
  description: true,
} satisfies Prisma.PermissionSelect;

export const roleDetailsSelect = {
  id: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.RoleSelect;
