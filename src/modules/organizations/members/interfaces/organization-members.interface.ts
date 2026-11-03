import type { Prisma } from '@/generated/prisma/client.js';

export interface ListOrganizationMembersInput {
  actorId: string;
  organizationId: string;
  page?: number;
  limit?: number;
  search?: string;
  roleId?: string;
}

export interface MemberDirectoryQuery {
  organizationId: string;
  where: Prisma.OrganizationMemberWhereInput;
  page: number;
  limit: number;
}
