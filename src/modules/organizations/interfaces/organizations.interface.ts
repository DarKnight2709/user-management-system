import type { Prisma } from '@/generated/prisma/client.js';

export interface ListOrganizationsInput {
  actorId: string;
  page?: number;
  limit?: number;
}

export interface DefaultRolePermission {
  id: string;
  resource: string;
  action: string;
}

export type OrganizationSnapshot = Prisma.OrganizationGetPayload<{
  select: {
    ownerId: true;
    deletedAt: true;
    name: true;
    slug: true;
  };
}>;
