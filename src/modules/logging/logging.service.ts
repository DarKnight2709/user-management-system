import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';

import type { AuthSecurityEventInput } from './types/auth-event.types.js';
import { parseAuthSecurityEvent } from './schemas/auth-event.schema.js';

import { AUTH_EVENT_POLICIES } from './policies/auth-event.policy.js';
import { ConfigService } from '@nestjs/config';

type EventEnvelope = {
  eventId: string;
  schemaVersion: 1;
  occurredAt: string;
  environment: string;
};

// export type StoredAuditEvent = EventEnvelope &
//   AuditInput & {
//     category: 'audit';
//     outcome: 'SUCCESS';
//   };

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
  // application(input: ApplicationInput): void {
  //   try {
  //     const parsed = applicationInputSchema.parse(input);
  //     const { level, metadata, ...body } = parsed;

  //     this.writeConsole(level, {
  //       ...body,
  //       metadata: metadata ? this.redactMetadata(metadata) : undefined,
  //       ...this.envelope(),
  //       category: 'application',
  //     });
  //   } catch {
  //     this.reportFailure('APPLICATION_LOG_FAILED');
  //   }
  // }

  /**
   * Security:
   * - Validates catalogued auth security events and writes them through Winston Console.
   * - Policy hiện tại chỉ xuất qua Winston Console.
   * - Không chờ Loki xác nhận lưu thành công.
   */
  security(input: AuthSecurityEventInput): void {
    try {
      const event = parseAuthSecurityEvent(input);
      const policy = AUTH_EVENT_POLICIES[event.action];

      this.writeConsole(policy.level, {
        ...event,
        ...this.envelope(),
        context: 'LoggingService',

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

  /**
   * Audit:
   * - Caller phải truyền tx đang xử lý nghiệp vụ.
   * - Lỗi validation/database được throw để transaction rollback.
   * - Không xuất Winston ở đây vì tx chưa commit.
   */
  // async audit(
  //   input: AuditInput,
  //   tx: Prisma.TransactionClient,
  // ): Promise<StoredAuditEvent> {
  //   const parsed = auditInputSchema.parse(input);
  //   const policy = AUDIT_POLICIES[parsed.action];

  //   if (parsed.changes.role.before === parsed.changes.role.after) {
  //     throw new Error('user.role.changed requires an actual role change');
  //   }

  //   const event: StoredAuditEvent = {
  //     ...parsed,
  //     ...this.envelope(),
  //     category: 'audit',
  //     outcome: policy.outcome,
  //   };

  //   // Serialize trước để kiểm tra tổng byte và tạo payload JSON.
  //   const serialized = this.serialize(event);

  //   const payload = JSON.parse(serialized) as Prisma.InputJsonObject;

  //   await tx.auditEvent.create({
  //     data: {
  //       eventId: event.eventId,
  //       schemaVersion: event.schemaVersion,
  //       action: event.action,
  //       outcome: event.outcome,
  //       actorId: event.actor.id,
  //       targetId: event.target.id,
  //       requestId: event.context.requestId,
  //       occurredAt: new Date(event.occurredAt),
  //       payload,
  //     },
  //   });

  //   return event;
  // }

  /**
   * Chỉ gọi sau khi $transaction(...) resolve thành công.
   * Đây là bản sao best-effort; PostgreSQL là bản chính.
   */
  // publishCommittedAudit(event: StoredAuditEvent): void {
  //   try {
  //     // Kiểm tra lại các trường nghiệp vụ.
  //     auditInputSchema.parse({
  //       action: event.action,
  //       actor: event.actor,
  //       target: event.target,
  //       changes: event.changes,
  //       context: event.context,
  //     });

  //     const policy = AUDIT_POLICIES[event.action];

  //     this.writeConsole(policy.level, {
  //       ...event,
  //       message: event.action,
  //     });
  //   } catch {
  //     // Không throw: nghiệp vụ đã commit.
  //     this.reportFailure('AUDIT_COPY_FAILED');
  //   }
  // }

  /**
   * Có thể dùng để kiểm tra trong giai đoạn đầu.
   * Khi thêm metrics, thay bằng counter có reason label hữu hạn.
   */
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
