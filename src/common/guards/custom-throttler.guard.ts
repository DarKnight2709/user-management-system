import {
  Inject,
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
import type { Request } from 'express';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { EMAIL_RATE_LIMIT_KEY } from '@/common/decorators/email-rate-limit.decorator.js';

const LOGIN_RATE_LIMIT_KEY = 'loginAccountRateLimit';

// counter increments, expiration, limit checks, and blocking through its guard and storage.
export class CustomThrottlerGuard extends ThrottlerGuard {
  @Inject(LoggingService)
  private readonly loggingService!: LoggingService;

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
      if (!this.isAccountRateLimited(requestProps.context)) {
        return true;
      }

      return this.handleRequestAndLogThrottle(requestProps, {
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

      return this.handleRequestAndLogThrottle(requestProps, {
        getTracker: this.getUserIdTracker,
      });
    }

    // handleRequest(IP policy)
    // the default getTracker function is used for IP policy
    return this.handleRequestAndLogThrottle(requestProps);
  }

  /** Login and email-keyed routes (forgot password) share the per-email policy. */
  private isAccountRateLimited(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    return [LOGIN_RATE_LIMIT_KEY, EMAIL_RATE_LIMIT_KEY].some(
      (key) => this.reflector.getAllAndOverride<boolean>(key, targets) === true,
    );
  }

  private async handleRequestAndLogThrottle(
    requestProps: ThrottlerRequest,
    overrides: Partial<Pick<ThrottlerRequest, 'getTracker'>> = {},
  ): Promise<boolean> {
    try {
      return await super.handleRequest({ ...requestProps, ...overrides });
    } catch (error) {
      const isLogin = this.reflector.getAllAndOverride<boolean>(
        LOGIN_RATE_LIMIT_KEY,
        [requestProps.context.getHandler(), requestProps.context.getClass()],
      );
      if (
        isLogin &&
        error instanceof HttpException &&
        error.getStatus() === HttpStatus.TOO_MANY_REQUESTS
      ) {
        const request = requestProps.context
          .switchToHttp()
          .getRequest<Request>();
        this.loggingService.security({
          action: 'auth.login.throttled',
          actor: { type: 'ANONYMOUS' },
          limitPolicy:
            requestProps.throttler.name === 'account' ? 'ACCOUNT' : 'IP',
          requestContext: {
            requestId: currentRequestId(),
            sourceIp: request.ip,
            userAgent: request.get('user-agent'),
          },
        });
      }
      throw error;
    }
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
