import { describe, expect, it, vi } from 'vitest';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { createBodyParserErrorMiddleware } from './body-parser-error.middleware.js';

function fixture() {
  const logging = { application: vi.fn() } as unknown as LoggingService;
  const response = {
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
  const next = vi.fn();
  const middleware = createBodyParserErrorMiddleware(logging);

  return { logging, response, next, middleware };
}

describe('Body parser error middleware', () => {
  it('logs malformed request bodies safely and returns a fixed 400 response', () => {
    const { logging, response, next, middleware } = fixture();
    const error = Object.assign(new SyntaxError('raw parser message'), {
      type: 'entity.parse.failed',
      body: 'body containing private values',
    });

    middleware(
      error,
      { path: '/auth/login' } as never,
      response as never,
      next,
    );

    const requestId = response.setHeader.mock.calls[0][1] as string;
    expect(response.setHeader).toHaveBeenCalledWith(
      'X-Request-ID',
      expect.any(String),
    );
    expect(logging.application.mock.calls).toContainEqual([
      {
        event: 'http.payload_invalid',
        statusCode: 400,
        requestContext: { requestId },
      },
    ]);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Malformed request body',
      }),
    );
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'raw parser message',
    );
    expect(JSON.stringify(logging.application.mock.calls)).not.toContain(
      'private values',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('logs oversized JSON using the existing payload-too-large event', () => {
    const { logging, response, next, middleware } = fixture();

    middleware(
      Object.assign(new Error('raw parser message'), {
        type: 'entity.too.large',
      }),
      { path: '/auth/login' } as never,
      response as never,
      next,
    );

    expect(logging.application.mock.calls[0][0]).toMatchObject({
      event: 'http.payload_too_large',
      statusCode: 413,
      requestContext: { requestId: expect.any(String) },
    });
    expect(response.status).toHaveBeenCalledWith(413);
    expect(next).not.toHaveBeenCalled();
  });

  it('passes unrelated errors to the next Express error handler', () => {
    const { logging, response, next, middleware } = fixture();
    const error = new Error('not a body parser error');

    middleware(error, {} as never, response as never, next);

    expect(next).toHaveBeenCalledWith(error);
    expect(logging.application.mock.calls).toHaveLength(0);
    expect(response.status).not.toHaveBeenCalled();
  });
});
