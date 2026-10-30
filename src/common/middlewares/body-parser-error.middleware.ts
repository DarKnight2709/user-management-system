import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler } from 'express';
import type { LoggingService } from '@/modules/logging/logging.service.js';

type ParserErrorType = 'entity.parse.failed' | 'entity.too.large';

export function createBodyParserErrorMiddleware(
  logging: LoggingService,
): ErrorRequestHandler {
  return (error, request, response, next) => {
    const parserErrorType = getParserErrorType(error);
    if (!parserErrorType) {
      next(error);
      return;
    }

    const isTooLarge = parserErrorType === 'entity.too.large';
    const statusCode = isTooLarge ? 413 : 400;
    const requestId = randomUUID();

    try {
      logging.application(
        isTooLarge
          ? {
              event: 'http.payload_too_large',
              statusCode: 413,
              requestContext: { requestId },
            }
          : {
              event: 'http.payload_invalid',
              statusCode: 400,
              requestContext: { requestId },
            },
      );
    } catch {
      // A logging failure must not prevent the parser error response.
    }

    response.setHeader('X-Request-ID', requestId);
    response.status(statusCode).json({
      statusCode,
      error: isTooLarge ? 'Payload Too Large' : 'Bad Request',
      message: isTooLarge
        ? 'Request body exceeds the allowed size'
        : 'Malformed request body',
      timestamp: new Date().toISOString(),
    });
  };
}

function getParserErrorType(error: unknown): ParserErrorType | undefined {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return undefined;
  }

  return error.type === 'entity.parse.failed' ||
    error.type === 'entity.too.large'
    ? error.type
    : undefined;
}
