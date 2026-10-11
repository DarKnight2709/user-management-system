import {
  ExecutionContext,
  HttpException,
  HttpStatus,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ThrottlerGetTrackerFunction,
  ThrottlerGuard,
  ThrottlerLimitDetail,
  ThrottlerRequest,
} from '@nestjs/throttler';
import { Response } from 'express';

// counter increments, expiration, limit checks, and blocking through its guard and storage.
export class CustomThrottlerGuard extends ThrottlerGuard {
  private readonly getLoginEmailTracker: ThrottlerGetTrackerFunction = async (
    req: Record<string, any>,
  ): Promise<string> => {
    const email: unknown = req.body?.email;

    return typeof email === 'string'
      ? email.trim().toLowerCase()
      : 'missing-email';
  };
  private readonly getUserIdTracker: ThrottlerGetTrackerFunction = async (
    req: Record<string, any>,
  ): Promise<string> => {
    const userId: unknown = req.user?.id;

    if (typeof userId !== 'string' || userId.length === 0) {
      throw new UnauthorizedException('Authentication required');
    }

    return userId;
  };

  /**
   * handleRequest(IP policy)
   *   ↓ if allowed
   * handleRequest(account policy)
   */
  protected async handleRequest(
    requestProps: ThrottlerRequest,
  ): Promise<boolean> {
    if (requestProps.throttler.name === 'account') {
      const enabled = this.reflector.getAllAndOverride<boolean>(
        'loginAccountRateLimit',
        [requestProps.context.getHandler(), requestProps.context.getClass()],
      );

      if (!enabled) {
        return true;
      }

      return super.handleRequest({
        ...requestProps,
        getTracker: this.getLoginEmailTracker,
      });
    } else if (requestProps.throttler.name === 'userId') {
      const enabled = this.reflector.getAllAndOverride<boolean>(
        'userIdRateLimit',
        [requestProps.context.getHandler(), requestProps.context.getClass()],
      );

      if (!enabled) {
        return true;
      }

      return super.handleRequest({
        ...requestProps,
        getTracker: this.getUserIdTracker,
      });
    }

    // handleRequest(IP policy)
    // the default getTracker function is used for IP policy
    return super.handleRequest(requestProps);
  }

  // handle the exception when the limit is exceeded
  protected async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const response = context.switchToHttp().getResponse<Response>();
    const retryAfterSeconds = Math.max(1, Math.ceil(detail.timeToBlockExpire));

    response.setHeader('Retry-After', retryAfterSeconds);

    throw new HttpException(
      {
        error: 'Too Many Requests',
        message: 'Too many requests. Please try again later.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
