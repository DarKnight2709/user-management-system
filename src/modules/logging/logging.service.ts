import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';

import type { SecurityEventInput } from './types/security-event.types.js';
import { parseAuthSecurityEvent } from './schemas/auth-event.schema.js';
import { parseAuthorizationDeniedEvent } from './schemas/authorization-denied-event.schema.js';

import { AUTH_EVENT_POLICIES } from './policies/auth-event.policy.js';
import { AUTHORIZATION_EVENT_POLICIES } from './policies/authorization-event.policy.js';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@/generated/prisma/client.js';
import type { ApplicationEventInput } from './types/application-event.types.js';
import { parseApplicationEvent } from './schemas/application-event.schema.js';
import type {
  AuditEventInput,
  StoredAuditEvent,
} from './types/audit-event.types.js';
import { parseAuditEvent } from './schemas/audit-event.schema.js';
import { AUDIT_POLICIES } from './policies/audit-event.policy.js';
import {
  APPLICATION_EVENT_POLICIES,
  applicationEventLevel,
} from './policies/application-event.policy.js';

type EventEnvelope = {
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  environment: string;
};

type FailureReason =
  | 'APPLICATION_LOG_FAILED'
  | 'SECURITY_LOG_FAILED'
  | 'AUDIT_COPY_FAILED'
  | 'WINSTON_TRANSPORT_FAILED';

const MAX_EVENT_BYTES = 16 * 1024;

// Lớp phòng vệ bổ sung cho application metadata.
// Không thay thế việc kiểm soát dữ liệu tại nơi gọi.

@Injectable()
export class LoggingService implements OnModuleDestroy {
  private failures = 0;

  // Không đưa raw error vào fallback vì có thể chứa secrets.
  private readonly onWinstonError = (): void => {
    this.reportFailure('WINSTON_TRANSPORT_FAILED');
  };

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER)
    private readonly logger: Logger,

    private readonly configService: ConfigService,
  ) {
    this.logger.on('error', this.onWinstonError);
  }

  onModuleDestroy(): void {
    // Logger do WinstonModule sở hữu; không close tại đây.
    this.logger.off('error', this.onWinstonError);
  }

  /**
   * Application log:
   * - Không ghi PostgreSQL.
   * - Lỗi logging không thay đổi kết quả nghiệp vụ.
   */
  application(input: ApplicationEventInput): void {
    try {
      const event = parseApplicationEvent(input);
      const policy = APPLICATION_EVENT_POLICIES[event.event];
      const requestId =
        'requestContext' in event ? event.requestContext?.requestId : undefined;

      this.writeConsole(applicationEventLevel(event), {
        ...event,
        ...this.envelope(),
        context: 'LoggingService',
        schemaVersion: policy.schemaVersion,
        category: policy.category,
        message: policy.message,
        ...(requestId ? { requestId } : {}),
      });
    } catch {
      this.reportFailure('APPLICATION_LOG_FAILED');
    }
  }

  /**
   * Security:
   * - Validates catalogued auth security events and writes them through Winston Console.
   * - Policy hiện tại chỉ xuất qua Winston Console.
   * - Không chờ Loki xác nhận lưu thành công.
   */
  security(input: SecurityEventInput): void {
    try {
      const event =
        input.action === 'authorization.denied'
          ? parseAuthorizationDeniedEvent(input)
          : parseAuthSecurityEvent(input);
      const policy =
        event.action === 'authorization.denied'
          ? AUTHORIZATION_EVENT_POLICIES[event.action]
          : AUTH_EVENT_POLICIES[event.action];

      this.writeConsole(policy.level, {
        ...event,
        ...this.envelope(),
        context: 'LoggingService',
        event: event.action,

        // Giá trị do policy quyết định.
        schemaVersion: policy.schemaVersion,
        category: policy.category,
        outcome: policy.outcome,

        // Giá trị do policy quyết định.
        message: event.action,
      });
    } catch {
      // Hai event hiện tại đều giữ nguyên kết quả xác thực
      // khi validation hoặc logging thất bại.
      this.reportFailure('SECURITY_LOG_FAILED');
    }
  }

  /** Persist the authoritative audit record in the caller's business transaction. */
  async audit(
    input: AuditEventInput,
    manager: Prisma.TransactionClient,
  ): Promise<StoredAuditEvent> {
    const parsed = parseAuditEvent(input);
    const policy = AUDIT_POLICIES[parsed.action];
    const event: StoredAuditEvent = {
      ...parsed,
      ...this.envelope(),
      category: policy.category,
      outcome: policy.outcome,
    };

    // Check the complete event size before writing in the business transaction.
    this.serialize(event);

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
  publishCommittedAudit(event: StoredAuditEvent): void {
    try {
      const policy = AUDIT_POLICIES[event.action];
      this.writeConsole(policy.level, {
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
      this.reportFailure('AUDIT_COPY_FAILED');
    }
  }
  getFailureCount(): number {
    return this.failures;
  }

  private envelope(): EventEnvelope {
    return {
      eventId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      environment: this.configService.get<string>('NODE_ENV', 'development'),
    };
  }

  private writeConsole(
    level: 'error' | 'warn' | 'info' | 'debug',
    event: Record<string, unknown> & { message: string },
  ): void {
    const serialized = this.serialize(event);

    // Tạo plain JSON object riêng, tránh giữ tham chiếu input.
    const payload = JSON.parse(serialized) as Record<string, unknown>;

    this.logger.log({
      ...payload,
      level,
      message: event.message,
    });
  }

  private serialize(event: object): string {
    const serialized = JSON.stringify(event);

    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
      throw new Error('Log event exceeds size limit');
    }

    return serialized;
  }

  // private redactMetadata(
  //   metadata: NonNullable<ApplicationInput['metadata']>,
  // ): Record<string, string | number | boolean | null> {
  //   const result: Record<string, string | number | boolean | null> =
  //     Object.create(null);

  //   for (const [key, value] of Object.entries(metadata)) {
  //     const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();

  //     result[key] = SENSITIVE_KEYS.has(normalizedKey) ? '[REDACTED]' : value;
  //   }

  //   return result;
  // }

  private reportFailure(reason: FailureReason): void {
    this.failures += 1;

    // Không gọi lại Winston để tránh vòng lặp lỗi logging.
    // Chỉ xuất fallback đầu tiên; counter giữ tổng số lần lỗi.
    if (this.failures !== 1) {
      return;
    }

    try {
      process.stderr.write(
        JSON.stringify({
          category: 'logging_internal',
          level: 'error',
          message: 'Logging pipeline failure',
          reason,
          occurredAt: new Date().toISOString(),
        }) + '\n',
      );
    } catch {
      // Fallback cũng không được phá luồng nghiệp vụ.
    }
  }
}
