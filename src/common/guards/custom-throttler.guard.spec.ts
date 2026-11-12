import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { EmailRateLimit } from '@/common/decorators/email-rate-limit.decorator.js';
import { CustomThrottlerGuard } from './custom-throttler.guard.js';

vi.mock('@/modules/logging/logging.service.js', () => ({
  LoggingService: class {},
}));

class LoginRoute {
  @SetMetadata('loginAccountRateLimit', true)
  handle() {}
}

class EmailRoute {
  @EmailRateLimit(3)
  handle() {}
}

@EmailRateLimit(3)
class EmailController {
  handle() {}
}

class PlainRoute {
  handle() {}
}

const contextFor = (route: { prototype: { handle: () => void } }) =>
  ({
    getHandler: () => route.prototype.handle,
    getClass: () => route,
  }) as unknown as ExecutionContext;

const isAccountRateLimited = (route: { prototype: { handle: () => void } }) => {
  const guard = new CustomThrottlerGuard(
    { throttlers: [] },
    {} as never,
    new Reflector(),
  );
  return guard['isAccountRateLimited'](contextFor(route));
};

describe('CustomThrottlerGuard per-email policy', () => {
  it('applies to login routes', () => {
    expect(isAccountRateLimited(LoginRoute)).toBe(true);
  });

  it('applies to routes limited by email', () => {
    expect(isAccountRateLimited(EmailRoute)).toBe(true);
  });

  it('applies to a controller limited by email', () => {
    expect(isAccountRateLimited(EmailController)).toBe(true);
  });

  it('does not apply to other routes', () => {
    expect(isAccountRateLimited(PlainRoute)).toBe(false);
  });
});
