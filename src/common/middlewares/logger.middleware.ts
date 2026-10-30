import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { requestContext } from '@/core/logging/request-context.js';
import { performance } from 'node:perf_hooks';
import { LoggingService } from '@/modules/logging/logging.service.js';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  constructor(private readonly logging: LoggingService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const requestId = randomUUID();

    res.setHeader('X-Request-ID', requestId);

    const start = performance.now();

    let logged = false;

    const logCompletion = (aborted: boolean) => {
      if (logged) return;

      logged = true;
      res.removeListener('finish', onFinish);
      res.removeListener('close', onClose);

      const { statusCode } = res;
      const duration = Math.round(performance.now() - start);

      const logData = {
        requestContext: { requestId },
        method: req.method,
        route:
          typeof req.route?.path === 'string' ? req.route.path : '[unmatched]', // /users/:id
        durationMs: duration,
      };
      if (aborted) {
        this.logging.application({
          ...logData,
          event: 'http.request.aborted',
          statusCode: null,
          outcome: 'aborted',
        });
      } else {
        this.logging.application({
          ...logData,
          event: 'http.request.completed',
          statusCode,
          outcome: 'completed',
        });
      }
    };
    const onFinish = () => logCompletion(false);
    const onClose = () => logCompletion(!res.writableFinished);

    res.once('finish', onFinish);
    res.once('close', onClose);

    requestContext.run({ requestId }, () => {
      next();
    });
  }
}
