import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { requestContext } from '@/core/logging/request-context.js';
import { performance } from 'node:perf_hooks';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LoggerMiddleware.name);

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
        message: aborted ? 'HTTP request aborted' : 'HTTP request completed',
        requestId,
        method: req.method,
        route:
          typeof req.route?.path === 'string' ? req.route.path : '[unmatched]', // /users/:id
        statusCode: aborted ? null : statusCode,
        durationMs: duration,
        outcome: aborted ? 'aborted' : 'completed',
      };
      if (aborted) {
        this.logger.warn(logData);
      } else if (res.statusCode >= 500) {
        this.logger.error(logData, undefined);
      } else if (res.statusCode >= 400) {
        this.logger.warn(logData);
      } else {
        this.logger.log(logData);
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
