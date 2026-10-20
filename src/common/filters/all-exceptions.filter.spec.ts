import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpException, Logger, type ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { AllExceptionsFilter } from './all-exceptions.filter.js';

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
  return {
    filter: new AllExceptionsFilter(adapter),
    host,
    reply,
    response,
    path,
  };
}

describe('AllExceptionsFilter safe logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps stack frames and standard error type without logging messages, URLs or properties', () => {
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { filter, host, reply, response, path } = fixture();
    const error = new TypeError('password=private-password');
    error.stack =
      'TypeError: password=private-password\nSQL values private-query\n    at changePassword (users.service.ts:20:5)\n    at controller (users.controller.ts:10:3)';
    Object.assign(error, { token: 'private-token' });
    filter.catch(error, host);
    expect(log).toHaveBeenCalledWith(
      {
        message: 'Unhandled request error',
        event: 'http.unhandled_error',
        statusCode: 500,
        errorType: 'TypeError',
        stack:
          '    at changePassword (users.service.ts:20:5)\n    at controller (users.controller.ts:10:3)',
      },
      undefined,
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
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
      const errorLog = vi
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => {});
      const warnLog = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      const { filter, host, reply, response, path } = fixture();
      const cause: Record<string, unknown> = { password: 'private-password' };
      cause.self = cause;
      const body = { message: 'Safe public message', code: 'FIXTURE_CODE' };
      filter.catch(new HttpException(body, status, { cause }), host);
      const expected = {
        message: 'HTTP request failed',
        event: 'http.operational_error',
        statusCode: status,
      };
      if (status >= 500) {
        expect(errorLog).toHaveBeenCalledWith(expected, undefined);
        expect(warnLog).not.toHaveBeenCalled();
      } else {
        expect(warnLog).toHaveBeenCalledWith(expected);
        expect(errorLog).not.toHaveBeenCalled();
      }
      expect(
        JSON.stringify([errorLog.mock.calls, warnLog.mock.calls]),
      ).not.toContain('private-');
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
    const log = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});
    const { filter, host } = fixture();
    const value = {
      toString() {
        throw new Error('private-value');
      },
    };
    expect(() => filter.catch(value, host)).not.toThrow();
    expect(log.mock.calls[0][0]).toMatchObject({ errorType: 'NonError' });
    const error = new Error('private-message');
    error.name = 'private-custom-name';
    filter.catch(error, host);
    expect(log.mock.calls[1][0]).toMatchObject({ errorType: 'Error' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
  });
});
