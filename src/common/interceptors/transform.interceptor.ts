import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { map, Observable } from 'rxjs';

export interface ApiResponse<T> {
  data: T;
  meta: {
    statusCode: number;
    path: string;
    timestamp: string;
  };
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<
  T,
  ApiResponse<T>
> {
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiResponse<T>> {
    const httpContext = context.switchToHttp();
    const req: Request = httpContext.getRequest();
    const res: Response = httpContext.getResponse();

    return next.handle().pipe(
      map((response) => {
        return {
          data: response ?? null,
          meta: {
            statusCode: res.statusCode,
            path: req.originalUrl,
            timestamp: new Date().toISOString(),
          },
        };
      }),
    );
  }
}
