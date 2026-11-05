import type { Prisma } from '@/generated/prisma/client.js';
import type {
  permissionDetailsSelect,
  roleDetailsSelect,
} from '../constants/organization-role.constant.js';

export type RolePermission = Prisma.PermissionGetPayload<{
  select: typeof permissionDetailsSelect;
}>;

export type RoleDetails = Prisma.RoleGetPayload<{
  select: typeof roleDetailsSelect;
}>;

export type PermissionKey = Pick<RolePermission, 'resource' | 'action'>;

export type RoleAction = 'create' | 'read' | 'update' | 'delete';

export interface RoleTarget {
  actorId: string;
  organizationId: string;
  roleId: string;
}

export interface RoleTransaction<Input> {
  manager: Prisma.TransactionClient;
  input: Input;
}

export interface CreateRoleInput {
  actorId: string;
  organizationId: string;
  name: string;
  permissionIds: string[];
}

export interface UpdateRoleChanges {
  name?: string;
  permissionIds?: string[];
}

export interface CustomRole extends RoleDetails {
  deletedAt: Date | null;
  rolePermissions: { permission: RolePermission }[];
}
