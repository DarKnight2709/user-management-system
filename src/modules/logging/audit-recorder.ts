import type { Prisma } from '@/generated/prisma/client.js';
import type { LogEmitter } from './log-emitter.js';
import { AUDIT_POLICIES } from './policies/audit-event.policy.js';
import { parseAuditEvent } from './schemas/audit-event.schema.js';
import type {
  AuditEventInput,
  StoredAuditEvent,
} from './types/audit-event.types.js';

/**
 * Audit pipeline: the PostgreSQL record is authoritative and written inside the
 * caller's transaction; the Winston copy is best-effort and published only
 * after that transaction commits.
 */
export class AuditRecorder {
  constructor(private readonly emitter: LogEmitter) {}

  /** Persist the authoritative audit record in the caller's business transaction. */
  async record(
    input: AuditEventInput,
    manager: Prisma.TransactionClient,
  ): Promise<StoredAuditEvent> {
    const parsed = parseAuditEvent(input);
    const policy = AUDIT_POLICIES[parsed.action];
    const event: StoredAuditEvent = {
      ...parsed,
      ...this.emitter.envelope(),
      category: policy.category,
      outcome: policy.outcome,
    };

    // Check the complete event size before writing in the business transaction.
    this.emitter.serialize(event);

    const payload = JSON.parse(
      JSON.stringify(event.payload),
    ) as Prisma.InputJsonValue;

    await manager.auditEvent.create({
      data: {
        eventId: event.eventId,
        schemaVersion: event.schemaVersion,
        action: event.action,
        actorId: 'id' in event.actor ? event.actor.id : null,
        actorType: event.actor.type,
        targetId: event.target.id,
        targetType: event.target.type,
        organizationId: 'organizationId' in event ? event.organizationId : null,
        requestId: event.requestContext.requestId,
        occurredAt: new Date(event.occurredAt),
        payload,
      },
    });

    return event;
  }

  /** Publish only after the transaction that stored this event has committed. */
  publishCommitted(event: StoredAuditEvent): void {
    try {
      const policy = AUDIT_POLICIES[event.action];
      this.emitter.write(policy.level, {
        ...event,
        event: event.action,
        schemaVersion: policy.schemaVersion,
        category: policy.category,
        outcome: policy.outcome,
        requestId: event.requestContext.requestId,
        message: event.action,
      });
    } catch {
      // The database record is authoritative; this console copy is best-effort.
      this.emitter.reportFailure('AUDIT_COPY_FAILED');
    }
  }
}
