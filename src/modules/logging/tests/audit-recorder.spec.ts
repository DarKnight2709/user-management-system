import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { LogEmitter } from '../log-emitter.js';
import { AuditRecorder } from '../audit-recorder.js';
import type { AuditEventInput } from '../types/audit-event.types.js';

const actorId = randomUUID();
const targetId = randomUUID();
const requestId = randomUUID();

const deletedEvent = (): AuditEventInput => ({
  action: 'user.deleted',
  actor: { type: 'USER', id: actorId },
  target: { type: 'USER', id: targetId },
  payload: { selfDeletion: false, revokedRefreshTokenCount: 2 },
  requestContext: { requestId },
});

function setup() {
  const emitter = {
    envelope: vi.fn(() => ({
      eventId: randomUUID(),
      schemaVersion: 1 as const,
      occurredAt: '2026-01-02T03:04:05.000Z',
      environment: 'test',
    })),
    serialize: vi.fn((event: object) => JSON.stringify(event)),
    write: vi.fn(),
    reportFailure: vi.fn(),
  };
  const manager = {
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
  };
  const recorder = new AuditRecorder(emitter as unknown as LogEmitter);
  return {
    recorder,
    emitter,
    manager,
    tx: manager as unknown as Prisma.TransactionClient,
  };
}

describe('AuditRecorder.record', () => {
  it('stores the event in the supplied transaction client', async () => {
    const { recorder, manager, tx } = setup();

    const stored = await recorder.record(deletedEvent(), tx);

    expect(manager.auditEvent.create).toHaveBeenCalledWith({
      data: {
        eventId: stored.eventId,
        schemaVersion: 1,
        action: 'user.deleted',
        actorId,
        actorType: 'USER',
        targetId,
        targetType: 'USER',
        organizationId: null,
        requestId,
        occurredAt: new Date('2026-01-02T03:04:05.000Z'),
        payload: { selfDeletion: false, revokedRefreshTokenCount: 2 },
      },
    });
  });

  it('adds the envelope and the policy category and outcome', async () => {
    const { recorder, tx } = setup();

    const stored = await recorder.record(deletedEvent(), tx);

    expect(stored).toMatchObject({
      schemaVersion: 1,
      environment: 'test',
      category: 'audit',
      outcome: 'SUCCESS',
    });
  });

  it('stores anonymous actors without an actor id', async () => {
    const { recorder, manager, tx } = setup();

    await recorder.record(
      {
        action: 'user.registered',
        actor: { type: 'ANONYMOUS' },
        target: { type: 'USER', id: targetId },
        payload: { registrationMethod: 'PASSWORD' },
        requestContext: { requestId },
      },
      tx,
    );

    const { data } = manager.auditEvent.create.mock.calls[0][0] as {
      data: { actorId: string | null; actorType: string };
    };
    expect(data).toMatchObject({ actorId: null, actorType: 'ANONYMOUS' });
  });

  it('stores the organization id of organization-scoped events', async () => {
    const { recorder, manager, tx } = setup();
    const organizationId = randomUUID();

    await recorder.record(
      {
        action: 'organization.deleted',
        actor: { type: 'USER', id: actorId },
        target: { type: 'ORGANIZATION', id: organizationId },
        organizationId,
        payload: {
          name: 'Acme',
          slug: 'acme',
          ownerId: actorId,
          revokedPendingInvitationCount: 0,
        },
        requestContext: { requestId },
      } as AuditEventInput,
      tx,
    );

    const { data } = manager.auditEvent.create.mock.calls[0][0] as {
      data: { organizationId: string };
    };
    expect(data.organizationId).toBe(organizationId);
  });

  it('rejects invalid events without writing or leaking values', async () => {
    const { recorder, manager, tx } = setup();
    const invalid = {
      ...deletedEvent(),
      payload: { selfDeletion: 'secret-value' },
    } as unknown as AuditEventInput;

    const failure = await recorder.record(invalid, tx).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Invalid audit event');
    expect(manager.auditEvent.create).not.toHaveBeenCalled();
  });

  it('rejects unknown actions', async () => {
    const { recorder, manager, tx } = setup();

    await expect(
      recorder.record(
        { ...deletedEvent(), action: 'user.exploded' } as never,
        tx,
      ),
    ).rejects.toThrow('Invalid audit event');
    expect(manager.auditEvent.create).not.toHaveBeenCalled();
  });

  it('fails before writing when the event is too large', async () => {
    const { recorder, emitter, manager, tx } = setup();
    emitter.serialize.mockImplementation(() => {
      throw new Error('Log event exceeds size limit');
    });

    await expect(recorder.record(deletedEvent(), tx)).rejects.toThrow(
      'size limit',
    );
    expect(manager.auditEvent.create).not.toHaveBeenCalled();
  });

  it('propagates persistence failures so the transaction rolls back', async () => {
    const { recorder, manager, tx } = setup();
    manager.auditEvent.create.mockRejectedValue(new Error('db down'));

    await expect(recorder.record(deletedEvent(), tx)).rejects.toThrow(
      'db down',
    );
  });

  it('does not publish anything while recording', async () => {
    const { recorder, emitter, tx } = setup();

    await recorder.record(deletedEvent(), tx);

    expect(emitter.write).not.toHaveBeenCalled();
  });
});

describe('AuditRecorder.publishCommitted', () => {
  it('copies the stored event to Winston at the policy level', async () => {
    const { recorder, emitter, tx } = setup();
    const stored = await recorder.record(deletedEvent(), tx);

    recorder.publishCommitted(stored);

    expect(emitter.write).toHaveBeenCalledWith(
      'info',
      expect.objectContaining({
        event: 'user.deleted',
        category: 'audit',
        outcome: 'SUCCESS',
        requestId,
        message: 'user.deleted',
        eventId: stored.eventId,
      }),
    );
  });

  it('reports a failed copy without throwing', async () => {
    const { recorder, emitter, tx } = setup();
    const stored = await recorder.record(deletedEvent(), tx);
    emitter.write.mockImplementation(() => {
      throw new Error('transport');
    });

    expect(() => recorder.publishCommitted(stored)).not.toThrow();
    expect(emitter.reportFailure).toHaveBeenCalledWith('AUDIT_COPY_FAILED');
  });
});
