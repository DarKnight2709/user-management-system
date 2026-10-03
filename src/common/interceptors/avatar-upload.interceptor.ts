import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  InternalServerErrorException,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import multer from 'multer';
import { Observable } from 'rxjs';
import type { Request, Response } from 'express';

@Injectable()
export class AvatarUploadInterceptor implements NestInterceptor {
  private readonly upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 2 * 1024 * 1024,
    },
  }).single('avatar');

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    await new Promise<void>((resolve, reject) => {
      this.upload(request, response, (error: unknown) => {
        if (!error) {
          resolve();
          return;
        }
        reject(this.mapUploadError(error));
      });
    });
    return next.handle();
  }

  private mapUploadError(error: unknown): Error {
    if (!(error instanceof multer.MulterError)) {
      return new InternalServerErrorException('Unknown server error');
    }

    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return new PayloadTooLargeException(
          'File too large! Maximum 2 MB allowed.',
        );

      case 'LIMIT_UNEXPECTED_FILE':
        return new BadRequestException(
          'Unexpected field name. Expected a single file under "avatar".',
        );

      default:
        return new BadRequestException(error.message);
    }
  }
}
