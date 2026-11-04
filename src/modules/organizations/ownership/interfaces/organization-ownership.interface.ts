import type { Prisma } from '@/generated/prisma/client.js';

export interface TransferOwnershipInput {
  actorId: string;
  organizationId: string;
  memberId: string;
}

export interface OwnershipTransaction {
  manager: Prisma.TransactionClient;
  input: TransferOwnershipInput;
}

export interface OwnerMembership {
  id: string;
}
