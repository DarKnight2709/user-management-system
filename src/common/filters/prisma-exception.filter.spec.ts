import { describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaClientExceptionFilter } from './prisma-exception.filter.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

const requestId = '11111111-1111-4111-8111-111111111111';

function fixture() {
  const response = {};
  const reply = vi.fn();
  const adapter = {
    httpAdapter: { getRequestUrl: () => '/fixture', reply },
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
    filter: new PrismaClientExceptionFilter(adapter, logging),
    application,
    host,
    reply,
    response,
  };
}

describe('PrismaClientExceptionFilter safe logging', () => {
  it('logs only a fixed event and Prisma code for an unhandled error', () => {
    const { filter, host, reply, response, application } = fixture();
    const error = new Prisma.PrismaClientKnownRequestError(
      'SQL diagnostic password=private-password',
      {
        code: 'P2021',
        clientVersion: 'fixture',
        meta: { table: 'private-table', token: 'private-token' },
      },
    );
    requestContext.run({ requestId }, () => filter.catch(error, host));
    expect(application).toHaveBeenCalledExactlyOnceWith({
      event: 'database.unhandled_error',
      code: 'P2021',
      requestContext: { requestId },
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private-');
    expect(reply).toHaveBeenCalledWith(
      response,
      {
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Database error occurred',
        timestamp: expect.any(String),
        path: '/fixture',
      },
      500,
    );
  });

  it.each([
    {
      code: 'P2002',
      meta: { target: ['email'] },
      status: 409,
      error: 'Conflict',
      message: 'Unique constraint failed on: email',
    },
    {
      code: 'P2025',
      meta: { cause: 'Record unavailable' },
      status: 404,
      error: 'Not Found',
      message: 'Record unavailable',
    },
    {
      code: 'P2003',
      meta: {},
      status: 400,
      error: 'Bad Request',
      message: 'Foreign key constraint violation',
    },
  ])(
    'preserves the existing HTTP mapping for $code',
    ({ code, meta, status, error, message }) => {
      const { filter, host, reply, response, application } = fixture();
      requestContext.run({ requestId }, () =>
        filter.catch(
          new Prisma.PrismaClientKnownRequestError('private-diagnostic', {
            code,
            meta,
            clientVersion: 'fixture',
          }),
          host,
        ),
      );
      expect(application).not.toHaveBeenCalled();
      expect(reply).toHaveBeenCalledWith(
        response,
        {
          statusCode: status,
          error,
          message,
          timestamp: expect.any(String),
          path: '/fixture',
        },
        status,
      );
    },
  );
});
