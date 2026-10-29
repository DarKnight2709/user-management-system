import { describe, expect, it, vi } from 'vitest';
import { HttpException, type ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

const requestId = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const response = {};
  const path = '/fixture?token=private-query';
  const reply = vi.fn();
  const adapter = {
    httpAdapter: { getRequestUrl: () => path, reply },
  } as unknown as HttpAdapterHost;
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({}),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  const application = vi.fn();
  const logging = { application } as unknown as LoggingService;
  return {
    filter: new AllExceptionsFilter(adapter, logging),
    application,
    host,
    reply,
    response,
    path,
  };
}

describe('AllExceptionsFilter safe logging', () => {
  it('keeps stack frames and standard error type without logging messages, URLs or properties', () => {
    const { filter, host, reply, response, path, application } = fixture();
    const error = new TypeError('password=private-password');
    error.stack =
      'TypeError: password=private-password\nSQL values private-query\n    at changePassword (users.service.ts:20:5)\n    at controller (users.controller.ts:10:3)';
    Object.assign(error, { token: 'private-token' });
    requestContext.run({ requestId }, () => filter.catch(error, host));
    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'http.unhandled_error',
      statusCode: 500,
      errorType: 'TypeError',
      stackFrames: [
        '    at changePassword (users.service.ts:20:5)',
        '    at controller (users.controller.ts:10:3)',
      ],
      requestContext: { requestId },
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
    expect(reply).toHaveBeenCalledWith(
      response,
      {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal server error',
        timestamp: expect.any(String),
        path,
      },
      500,
    );
  });

  it.each([400, 503])(
    'logs safe HTTP cause metadata with severity appropriate to %i and preserves the response',
    (status) => {
      const { filter, host, reply, response, path, application } = fixture();
      const cause: Record<string, unknown> = { password: 'private-password' };
      cause.self = cause;
      const body = { message: 'Safe public message', code: 'FIXTURE_CODE' };
      requestContext.run({ requestId }, () =>
        filter.catch(new HttpException(body, status, { cause }), host),
      );
      expect(application).toHaveBeenCalledExactlyOnceWith({
        event: 'http.operational_error',
        statusCode: status,
        requestContext: { requestId },
      });
      expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
      expect(reply).toHaveBeenCalledWith(
        response,
        {
          statusCode: status,
          ...body,
          timestamp: expect.any(String),
          path,
        },
        status,
      );
    },
  );

  it('does not stringify non-Error values or expose a custom error name', () => {
    const { filter, host, application } = fixture();
    const value = {
      toString() {
        throw new Error('private-value');
      },
    };
    expect(() =>
      requestContext.run({ requestId }, () => filter.catch(value, host)),
    ).not.toThrow();
    expect(application.mock.calls[0][0]).toMatchObject({
      errorType: 'NonError',
    });
    const error = new Error('private-message');
    error.name = 'private-custom-name';
    requestContext.run({ requestId }, () => filter.catch(error, host));
    expect(application.mock.calls[1][0]).toMatchObject({ errorType: 'Error' });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
  });

  it('classifies parser size errors without exposing parser diagnostics', () => {
    const { filter, host, application, reply, response, path } = fixture();
    const error = Object.assign(new Error('private-parser-message'), {
      type: 'entity.too.large',
      status: 413,
    });
    requestContext.run({ requestId }, () => filter.catch(error, host));
    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'http.payload_too_large',
      statusCode: 413,
      requestContext: { requestId },
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
    expect(reply).toHaveBeenCalledWith(
      response,
      {
        statusCode: 413,
        error: 'Payload Too Large',
        message: 'Request body exceeds the allowed size',
        timestamp: expect.any(String),
        path,
      },
      413,
    );
  });
});
