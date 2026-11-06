import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { Logger } from 'winston';
import {
  MAX_EVENT_BYTES,
  type LogFailureReason,
} from './constants/logging.constant.js';
import type { EventEnvelope } from './interfaces/logging.interface.js';

/**
 * Low-level Winston output shared by every event kind: envelope creation,
 * size-bounded serialization and the logging-failure counter. Logging failures
 * never change business results and never recurse into Winston.
 */
export class LogEmitter {
  private failures = 0;

  // Không đưa raw error vào fallback vì có thể chứa secrets.
  private readonly onWinstonError = (): void => {
    this.reportFailure('WINSTON_TRANSPORT_FAILED');
  };

  constructor(
    private readonly logger: Logger,
    private readonly configService: ConfigService,
  ) {
    this.logger.on('error', this.onWinstonError);
  }

  /** Logger do WinstonModule sở hữu; chỉ gỡ listener, không close. */
  dispose(): void {
    this.logger.off('error', this.onWinstonError);
  }

  getFailureCount(): number {
    return this.failures;
  }

  envelope(): EventEnvelope {
    return {
      eventId: randomUUID(),
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      environment: this.configService.get<string>('NODE_ENV', 'development'),
    };
  }

  /** Throws when the serialized event exceeds the size limit. */
  serialize(event: object): string {
    const serialized = JSON.stringify(event);

    if (Buffer.byteLength(serialized, 'utf8') > MAX_EVENT_BYTES) {
      throw new Error('Log event exceeds size limit');
    }

    return serialized;
  }

  write(
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

  reportFailure(reason: LogFailureReason): void {
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
