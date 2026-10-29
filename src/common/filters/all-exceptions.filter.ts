import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

// This filter will differentiate between HttpException and unexpected Errors
@Catch() // catch everything: HttpException and raw unexpected Errors
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logging: LoggingService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    const timestamp = new Date().toISOString();
    const path = httpAdapter.getRequestUrl(request);

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let errorResponse: Record<string, any> = {
      statusCode: status,
      error: 'Internal Server Error',
      message: 'An unexpected internal error occurred',
      timestamp,
      path,
    };

    // 1. Handle HttpException
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      const cause = exception.cause;

      if (cause) {
        this.logging.application({
          event: 'http.operational_error',
          statusCode: status,
          requestContext: {
            requestId: requestContext.getStore()?.requestId ?? randomUUID(),
          },
        });
      }

      if (typeof res === 'string') {
        errorResponse = {
          statusCode: status,
          error: exception.name,
          message: res,
          timestamp,
          path,
        };
      } else if (typeof res === 'object' && res !== null) {
        // Preserves custom structures (Ex: from InputValidationPipe)
        errorResponse = {
          statusCode: status,
          ...res,
          timestamp,
          path,
        };
      }
    } else if (
      exception instanceof Error &&
      'type' in exception &&
      exception.type === 'entity.too.large' &&
      'status' in exception &&
      exception.status === HttpStatus.PAYLOAD_TOO_LARGE
    ) {
      status = HttpStatus.PAYLOAD_TOO_LARGE;

      errorResponse = {
        statusCode: status,
        error: 'Payload Too Large',
        message: 'Request body exceeds the allowed size',
        timestamp,
        path,
      };

      this.logging.application({
        event: 'http.payload_too_large',
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        requestContext: {
          requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        },
      });
    }
    // 2. Unexpected System Crashes (Error / TypeError / DB drops)
    else {
      const err = exception instanceof Error ? exception : undefined;
      const knownErrorTypes = [
        'Error',
        'TypeError',
        'RangeError',
        'ReferenceError',
        'SyntaxError',
        'URIError',
        'EvalError',
        'AggregateError',
      ] as const;
      const errorType = err
        ? knownErrorTypes.includes(err.name as (typeof knownErrorTypes)[number])
          ? (err.name as (typeof knownErrorTypes)[number])
          : 'Error'
        : 'NonError';
      // Raw messages, causes, URLs and custom error properties may contain secrets.
      // Keep only call-site frames, excluding message and driver diagnostic lines.
      const stackFrames = err?.stack
        ?.split('\n')
        .slice(1)
        .filter((line) => /^\s+at /.test(line))
        .slice(0, 32);
      this.logging.application({
        event: 'http.unhandled_error',
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        errorType,
        stackFrames: stackFrames?.length ? stackFrames : undefined,
        requestContext: {
          requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        },
      });

      // NEVER leak raw crash details or stack traces to external clients
      errorResponse = {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Internal Server Error',
        message: 'Internal server error',
        timestamp,
        path,
      };
    }

    httpAdapter.reply(response, errorResponse, status);
  }
}
