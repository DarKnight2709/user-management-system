import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

// This filter will differentiate between HttpException and unexpected Errors
@Catch() // catch everything: HttpException and raw unexpected Errors
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

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
        this.logger.warn(
          `Operational Exception [${status}] at ${path} - Cause: ${
            cause instanceof Error ? cause.message : JSON.stringify(cause)
          }`,
        );
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
    }
    // 2. Unexpected System Crashes (Error / TypeError / DB drops)
    else {
      const err =
        exception instanceof Error ? exception : new Error(String(exception));

      // Log full stack trace internally for debugging
      this.logger.error(
        `Unhandled Crash on ${path}: ${err.message}`,
        err.stack,
      );

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
