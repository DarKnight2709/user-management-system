import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { AuditEventReader } from '../services/audit-event-reader.service.js';
import type { AuditEventFilters } from '../interfaces/audit-logs.interface.js';

const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const otherOrganizationId = '523e4567-e89b-42d3-a456-426614174000';
const actorId = '323e4567-e89b-42d3-a456-426614174000';
const targetId = '423e4567-e89b-42d3-a456-426614174000';

const query = (overrides: Partial<AuditEventFilters> = {}) =>
  ({ page: 1, limit: 20, ...overrides }) as AuditEventFilters;

function setup() {
  const manager = {
    auditEvent: {
      findMany: vi.fn().mockResolvedValue([{ eventId: 'e1' }]),
      count: vi.fn().mockResolvedValue(41),
    },
  };
  return {
    reader: new AuditEventReader(),
    manager,
    tx: manager as unknown as Prisma.TransactionClient,
  };
}

describe('AuditEventReader.buildWhere', () => {
  const reader = new AuditEventReader();

  it('is empty without filters', () => {
    expect(reader.buildWhere(query())).toEqual({});
  });

  it('applies every supplied filter', () => {
    expect(
      reader.buildWhere(
        query({
          organizationId,
          action: 'user.deleted',
          actorId,
          targetId,
          targetType: 'USER',
        }),
      ),
    ).toEqual({
      organizationId,
      action: 'user.deleted',
      actorId,
      targetId,
      targetType: 'USER',
    });
  });

  it('forces the route organization over a client-supplied one', () => {
    expect(
      reader.buildWhere(
        query({ organizationId: otherOrganizationId }),
        organizationId,
      ),
    ).toEqual({ organizationId });
  });

  it('scopes to the route organization even with no client filter', () => {
    expect(reader.buildWhere(query(), organizationId)).toEqual({
      organizationId,
    });
  });
});

describe('AuditEventReader.readPage', () => {
  it('orders newest first with an event id tiebreaker and pages by offset', async () => {
    const { reader, manager, tx } = setup();

    await reader.readPage(tx, query({ page: 3, limit: 10 }));

    expect(manager.auditEvent.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 20,
      take: 10,
      orderBy: [{ occurredAt: 'desc' }, { eventId: 'desc' }],
    });
  });

  it('counts with the same filter as the page', async () => {
    const { reader, manager, tx } = setup();

    await reader.readPage(
      tx,
      query({ action: 'user.deleted' }),
      organizationId,
    );

    const expected = { organizationId, action: 'user.deleted' };
    expect(manager.auditEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expected }),
    );
    expect(manager.auditEvent.count).toHaveBeenCalledWith({ where: expected });
  });

  it('returns items, total and the requested page numbers', async () => {
    const { reader, tx } = setup();

    await expect(
      reader.readPage(tx, query({ page: 2, limit: 5 })),
    ).resolves.toEqual({
      items: [{ eventId: 'e1' }],
      total: 41,
      page: 2,
      limit: 5,
    });
  });

  it('propagates database errors', async () => {
    const { reader, manager, tx } = setup();
    manager.auditEvent.count.mockRejectedValue(new Error('db down'));

    await expect(reader.readPage(tx, query())).rejects.toThrow('db down');
  });
});
