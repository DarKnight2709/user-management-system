import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { AuditViewRecorder } from '../audit-view-recorder.service.js';
import type { AuditEventFilters } from '../interfaces/audit-logs.interface.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const requestId = '723e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const targetId = '423e4567-e89b-42d3-a456-426614174000';

const query = (overrides: Partial<AuditEventFilters> = {}) =>
  ({ page: 2, limit: 10, ...overrides }) as AuditEventFilters;

function setup() {
  const stored = { eventId: 'stored' };
  const logging = {
    audit: vi.fn().mockResolvedValue(stored),
    publishCommittedAudit: vi.fn(),
  };
  const manager = {} as Prisma.TransactionClient;
  return {
    recorder: new AuditViewRecorder(logging as unknown as LoggingService),
    logging,
    manager,
    stored,
  };
}

describe('AuditViewRecorder.recordPlatformView', () => {
  it('records a platform view in the supplied transaction', async () => {
    const { recorder, logging, manager, stored } = setup();

    await expect(
      recorder.recordPlatformView(manager, actorId, requestId, query()),
    ).resolves.toBe(stored);

    expect(logging.audit).toHaveBeenCalledWith(
      {
        action: 'audit.log.viewed',
        actor: { type: 'USER', id: actorId },
        target: { type: 'AUDIT_LOG', id: requestId },
        payload: { scope: 'PLATFORM', page: 2, limit: 10 },
        requestContext: { requestId },
      },
      manager,
    );
  });

  it('includes only the filters that were supplied', async () => {
    const { recorder, logging, manager } = setup();

    await recorder.recordPlatformView(
      manager,
      actorId,
      requestId,
      query({ action: 'user.deleted', actorId, targetId, targetType: 'USER' }),
    );

    const [event] = logging.audit.mock.calls[0] as [
      { payload: Record<string, unknown> },
    ];
    expect(event.payload).toEqual({
      scope: 'PLATFORM',
      page: 2,
      limit: 10,
      actionFilter: 'user.deleted',
      actorIdFilter: actorId,
      targetIdFilter: targetId,
      targetTypeFilter: 'USER',
    });
  });

  it('records the organization filter on the event and in the payload', async () => {
    const { recorder, logging, manager } = setup();

    await recorder.recordPlatformView(
      manager,
      actorId,
      requestId,
      query({ organizationId }),
    );

    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        payload: expect.objectContaining({
          organizationFilter: organizationId,
        }),
      }),
      manager,
    );
  });
});

describe('AuditViewRecorder.recordOrganizationView', () => {
  it('scopes the event to the route organization', async () => {
    const { recorder, logging, manager } = setup();

    await recorder.recordOrganizationView(
      manager,
      actorId,
      organizationId,
      requestId,
      query({ action: 'audit.log.viewed' }),
    );

    expect(logging.audit).toHaveBeenCalledWith(
      {
        action: 'audit.log.viewed',
        actor: { type: 'USER', id: actorId },
        target: { type: 'AUDIT_LOG', id: requestId },
        organizationId,
        payload: {
          scope: 'ORGANIZATION',
          page: 2,
          limit: 10,
          actionFilter: 'audit.log.viewed',
        },
        requestContext: { requestId },
      },
      manager,
    );
  });

  it('never records a platform-only organization filter', async () => {
    const { recorder, logging, manager } = setup();

    await recorder.recordOrganizationView(
      manager,
      actorId,
      organizationId,
      requestId,
      query({ organizationId: targetId }),
    );

    const [event] = logging.audit.mock.calls[0] as [
      { payload: Record<string, unknown> },
    ];
    expect(event.payload).not.toHaveProperty('organizationFilter');
  });

  it('propagates failures so the read fails with the transaction', async () => {
    const { recorder, logging, manager } = setup();
    logging.audit.mockRejectedValue(new Error('db down'));

    await expect(
      recorder.recordOrganizationView(
        manager,
        actorId,
        organizationId,
        requestId,
        query(),
      ),
    ).rejects.toThrow('db down');
  });
});

describe('AuditViewRecorder.publish', () => {
  it('delegates the post-commit copy to LoggingService', () => {
    const { recorder, logging, stored } = setup();

    recorder.publish(stored as never);

    expect(logging.publishCommittedAudit).toHaveBeenCalledWith(stored);
  });
});
