import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';

import type { Prisma } from '@/generated/prisma/client.js';
import { AuditRecorder } from './audit-recorder.js';
import { LogEmitter } from './log-emitter.js';
import {
  APPLICATION_EVENT_POLICIES,
  applicationEventLevel,
} from './policies/application-event.policy.js';
import { AUTH_EVENT_POLICIES } from './policies/auth-event.policy.js';
import { AUTHORIZATION_EVENT_POLICIES } from './policies/authorization-event.policy.js';
import { parseApplicationEvent } from './schemas/application-event.schema.js';
import { parseAuthSecurityEvent } from './schemas/auth-event.schema.js';
import { parseAuthorizationDeniedEvent } from './schemas/authorization-denied-event.schema.js';
import type { ApplicationEventInput } from './types/application-event.types.js';
import type {
  AuditEventInput,
  StoredAuditEvent,
} from './types/audit-event.types.js';
import type { SecurityEventInput } from './types/security-event.types.js';

/**
 * Public logging entry point. Validates catalogued events and delegates output
 * to LogEmitter and audit persistence to AuditRecorder.
 */
@Injectable()
export class LoggingService implements OnModuleDestroy {
  private readonly emitter: LogEmitter;
  private readonly auditRecorder: AuditRecorder;

  constructor(
    @Inject(WINSTON_MODULE_PROVIDER) logger: Logger,
    configService: ConfigService,
  ) {
    this.emitter = new LogEmitter(logger, configService);
    this.auditRecorder = new AuditRecorder(this.emitter);
  }

  onModuleDestroy(): void {
    this.emitter.dispose();
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

      this.emitter.write(applicationEventLevel(event), {
        ...event,
        ...this.emitter.envelope(),
        context: 'LoggingService',
        schemaVersion: policy.schemaVersion,
        category: policy.category,
        message: policy.message,
        ...(requestId ? { requestId } : {}),
      });
    } catch {
      this.emitter.reportFailure('APPLICATION_LOG_FAILED');
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

      this.emitter.write(policy.level, {
        ...event,
        ...this.emitter.envelope(),
        context: 'LoggingService',
        event: event.action,

        // Giá trị do policy quyết định.
        schemaVersion: policy.schemaVersion,
        category: policy.category,
        outcome: policy.outcome,
        message: event.action,
      });
    } catch {
      // Hai event hiện tại đều giữ nguyên kết quả xác thực
      // khi validation hoặc logging thất bại.
      this.emitter.reportFailure('SECURITY_LOG_FAILED');
    }
  }

  /** Persist the authoritative audit record in the caller's business transaction. */
  audit(
    input: AuditEventInput,
    manager: Prisma.TransactionClient,
  ): Promise<StoredAuditEvent> {
    return this.auditRecorder.record(input, manager);
  }

  /** Publish only after the transaction that stored this event has committed. */
  publishCommittedAudit(event: StoredAuditEvent): void {
    this.auditRecorder.publishCommitted(event);
  }

  getFailureCount(): number {
    return this.emitter.getFailureCount();
  }
}
