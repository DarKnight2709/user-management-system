import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@/generated/prisma/client.js';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaClientExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logging: LoggingService,
  ) {}

  catch(
    exception: Prisma.PrismaClientKnownRequestError,
    host: ArgumentsHost,
  ): void {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    const timestamp = new Date().toISOString();
    const path = httpAdapter.getRequestUrl(request);
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Database error occurred';
    let error = 'Internal Server Error';

    switch (exception.code) {
      // P2002: Unique constraint violation (e.g., duplicate email)
      case 'P2002': {
        status = HttpStatus.CONFLICT;
        const target =
          (exception.meta?.target as string[])?.join(', ') || 'field';
        error = 'Conflict';
        message = `Unique constraint failed on: ${target}`;
        break;
      }
      // P2025: Record to update or delete not found
      case 'P2025': {
        status = HttpStatus.NOT_FOUND;
        error = 'Not Found';
        message = (exception.meta?.cause as string) || 'Record not found';
        break;
      }
      // P2003: Foreign key constraint failed
      case 'P2003': {
        status = HttpStatus.BAD_REQUEST;
        error = 'Bad Request';
        message = 'Foreign key constraint violation';
        break;
      }
      default:
        // Raw Prisma messages and metadata can include SQL and sensitive values.
        this.logging.application({
          event: 'database.unhandled_error',
          code: exception.code,
          requestContext: {
            requestId: requestContext.getStore()?.requestId ?? randomUUID(),
          },
        });
        break;
    }
    const responseBody = {
      statusCode: status,
      error,
      message,
      timestamp,
      path,
    };
    httpAdapter.reply(response, responseBody, status);
  }
}
