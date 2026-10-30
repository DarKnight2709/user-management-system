import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import { LoggerMiddleware } from './logger.middleware.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

function fixture(statusCode = 200, route: unknown = '/users/:id') {
  const log = vi.fn();
  const winston = { on: vi.fn(), off: vi.fn(), log } as unknown as Logger;
  const middleware = new LoggerMiddleware(
    new LoggingService(winston, new ConfigService()),
  );
  const response = Object.assign(new EventEmitter(), {
    statusCode,
    writableFinished: false,
    setHeader: vi.fn(),
  });
  const request = {
    method: 'GET',
    route: { path: route },
    originalUrl: '/users/private-user?token=private-token',
    headers: { authorization: 'private-token' },
    body: { password: 'private-password' },
  } as unknown as Request;
  const next = vi.fn(() =>
    expect(requestContext.getStore()?.requestId).toBe(
      response.setHeader.mock.calls[0][1],
    ),
  );
  middleware.use(request, response as unknown as Response, next);
  return { response, log, next };
}

describe('HTTP application logging', () => {
  it.each([
    [200, 'info'],
    [401, 'warn'],
    [500, 'error'],
  ] as const)('logs completed %i once at %s level', (statusCode, level) => {
    const { response, log, next } = fixture(statusCode);
    response.writableFinished = true;
    response.emit('finish');
    response.emit('close');

    expect(next).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'http.request.completed',
      category: 'application',
      level,
      statusCode,
      outcome: 'completed',
      route: '/users/:id',
      method: 'GET',
      durationMs: expect.any(Number),
      requestId: response.setHeader.mock.calls[0][1],
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    expect(response.listenerCount('close')).toBe(0);
    expect(response.listenerCount('finish')).toBe(0);
  });

  it('logs early close as aborted without inventing a status code', () => {
    const { response, log } = fixture();
    response.emit('close');
    response.emit('finish');

    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'http.request.aborted',
      statusCode: null,
      outcome: 'aborted',
      level: 'warn',
    });
  });

  it('treats close after response completion as completed', () => {
    const { response, log } = fixture(204);
    response.writableFinished = true;
    response.emit('close');
    expect(log.mock.calls[0][0]).toMatchObject({
      event: 'http.request.completed',
      statusCode: 204,
    });
  });

  it.each([null, /users/, 'x'.repeat(513), '/users\nforged'])(
    'uses a safe fallback for an unsafe route template',
    (route) => {
      const { response, log } = fixture(404, route);
      response.emit('finish');
      expect(log.mock.calls[0][0].route).toBe('[unmatched]');
      expect(JSON.stringify(log.mock.calls)).not.toContain('private-token');
    },
  );
});
