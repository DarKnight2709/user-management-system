import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LoggerMiddleware.name);

  use(req: Request, res: Response, next: NextFunction) {
    const { method, originalUrl } = req;

    const start = Date.now();

    res.on('finish', () => {
      const { statusCode } = res;
      const duration = Date.now() - start;

      const logData = {
        method,
        originalUrl,
        statusCode,
        duration,
      };

      // lỗi server (500+) -> ERROR
      if (res.statusCode >= 500) this.logger.error(logData);
      // lỗi client (400-499) -> WARN
      else if (res.statusCode >= 400) this.logger.warn(logData);
      // Thành công (200 -> 399) -> LOG
      else this.logger.log(logData);
    });

    next();
  }
}
