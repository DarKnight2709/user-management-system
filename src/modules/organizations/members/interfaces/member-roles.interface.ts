import type { Prisma } from '@/generated/prisma/client.js';

export interface ChangeMemberRoleInput {
  actorId: string;
  organizationId: string;
  memberId: string;
  roleId: string;
}

export interface MemberRoleContext {
  member: {
    id: string;
    userId: string;
  };
  role: {
    id: string;
    name: string;
    rolePermissions: {
      permission: {
        resource: string;
        action: string;
      };
    }[];
  };
}

export interface MemberRoleTransaction {
  manager: Prisma.TransactionClient;
  input: ChangeMemberRoleInput;
}

export interface PermissionDelegationInput {
  manager: Prisma.TransactionClient;
  input: ChangeMemberRoleInput;
  isOwner: boolean;
  requiredPermissions: { resource: string; action: string }[];
}
