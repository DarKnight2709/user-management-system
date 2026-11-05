import { vi } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { PrismaService } from '../../src/core/database/prisma.service.js';

/** Runs serializable transactions directly against the supplied fake client. */
export function createPrismaStub(manager: object): PrismaService {
  return {
    serializableTransaction: vi.fn(
      (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(manager as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;
}
