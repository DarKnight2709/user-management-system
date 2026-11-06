import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import type { PrismaClient } from '@/generated/prisma/client.js';
import {
  createIsolatedDatabase,
  type IsolatedDatabase,
} from '../../../../test/support/isolated-database.js';
import { LoggingService } from '../logging.service.js';
import type { AuditEventInput } from '../types/audit-event.types.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';

const actorId = randomUUID();

const deletedEvent = (targetId = randomUUID()): AuditEventInput => ({
  action: 'user.deleted',
  actor: { type: 'USER', id: actorId },
  target: { type: 'USER', id: targetId },
  payload: { selfDeletion: false, revokedRefreshTokenCount: 4 },
  requestContext: { requestId: randomUUID() },
});

describe.runIf(runDatabaseTests)('Audit persistence integration', () => {
  let database: IsolatedDatabase;
  let db: PrismaClient;
  let log: ReturnType<typeof vi.fn>;
  let service: LoggingService;

  beforeAll(async () => {
    database = await createIsolatedDatabase('audit');
    db = database.db;
  }, 30_000);

  beforeEach(async () => {
    await db.auditEvent.deleteMany();
    log = vi.fn();
    service = new LoggingService(
      { on: vi.fn(), off: vi.fn(), log } as unknown as Logger,
      new ConfigService({ NODE_ENV: 'test' }),
    );
  });

  afterAll(async () => {
    await database?.dispose();
  });

  it('persists every column of a user audit event', async () => {
    const input = deletedEvent();

    const stored = await database.prisma.serializableTransaction((manager) =>
      service.audit(input, manager),
    );

    const row = await db.auditEvent.findUniqueOrThrow({
      where: { eventId: stored.eventId },
    });
    expect(row).toMatchObject({
      schemaVersion: 1,
      action: 'user.deleted',
      actorId,
      actorType: 'USER',
      targetId: input.target.id,
      targetType: 'USER',
      organizationId: null,
      requestId: input.requestContext.requestId,
      payload: { selfDeletion: false, revokedRefreshTokenCount: 4 },
    });
    expect(row.occurredAt.toISOString()).toBe(stored.occurredAt);
    expect(row.recordedAt).toBeInstanceOf(Date);
  });

  it('stores anonymous registrations without an actor id', async () => {
    const targetId = randomUUID();

    await database.prisma.serializableTransaction((manager) =>
      service.audit(
        {
          action: 'user.registered',
          actor: { type: 'ANONYMOUS' },
          target: { type: 'USER', id: targetId },
          payload: { registrationMethod: 'PASSWORD' },
          requestContext: { requestId: randomUUID() },
        },
        manager,
      ),
    );

    await expect(
      db.auditEvent.findFirstOrThrow({ where: { targetId } }),
    ).resolves.toMatchObject({ actorId: null, actorType: 'ANONYMOUS' });
  });

  it('rolls the audit record back with the surrounding transaction', async () => {
    const input = deletedEvent();

    await expect(
      database.prisma.serializableTransaction(async (manager) => {
        await service.audit(input, manager);
        throw new Error('business failure');
      }),
    ).rejects.toThrow('business failure');

    await expect(
      db.auditEvent.count({ where: { targetId: input.target.id } }),
    ).resolves.toBe(0);
  });

  it('writes nothing to Winston until the copy is published', async () => {
    const stored = await database.prisma.serializableTransaction((manager) =>
      service.audit(deletedEvent(), manager),
    );
    expect(log).not.toHaveBeenCalled();

    service.publishCommittedAudit(stored);

    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: stored.eventId,
        event: 'user.deleted',
      }),
    );
  });

  it('rejects a duplicate event id', async () => {
    const stored = await database.prisma.serializableTransaction((manager) =>
      service.audit(deletedEvent(), manager),
    );

    await expect(
      db.auditEvent.create({
        data: {
          eventId: stored.eventId,
          schemaVersion: 1,
          action: 'user.deleted',
          actorType: 'USER',
          targetId: randomUUID(),
          targetType: 'USER',
          requestId: randomUUID(),
          occurredAt: new Date(),
          payload: {},
        },
      }),
    ).rejects.toBeDefined();
  });

  it('keeps concurrent audit writes independent', async () => {
    const inputs = Array.from({ length: 5 }, () => deletedEvent());

    await Promise.all(
      inputs.map((input) =>
        database.prisma.serializableTransaction((manager) =>
          service.audit(input, manager),
        ),
      ),
    );

    await expect(db.auditEvent.count()).resolves.toBe(5);
  });
});
