import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { PrismaService } from './prisma.service.js';

const state = vi.hoisted(() => ({
  adapterArguments: [] as unknown[],
  createdPools: [] as object[],
}));

vi.mock('@/generated/prisma/client.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  PrismaClient: class {
    $on() {}
  },
}));
vi.mock('pg', () => ({
  Pool: class {
    constructor() {
      state.createdPools.push(this);
    }
  },
}));
vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(...adapterArguments: unknown[]) {
      state.adapterArguments = adapterArguments;
    }
  },
}));

function createService() {
  return new PrismaService(
    new ConfigService({
      DATABASE_URL: 'postgresql://fixture.invalid/unused',
      NODE_ENV: 'production',
    }),
    { application: vi.fn() } as unknown as LoggingService,
  );
}

describe('PrismaService connection pool', () => {
  it('gives the adapter the pool it created', () => {
    createService();

    expect(state.adapterArguments[0]).toBe(state.createdPools.at(-1));
  });

  it('asks the adapter to close that pool on disconnect', () => {
    createService();

    expect(state.adapterArguments[1]).toEqual({ disposeExternalPool: true });
  });
});
