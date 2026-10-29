import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { AuthService } from './auth.service.js';
import { requestContext } from '@/core/logging/request-context.js';

vi.mock('../users/users.service.js', () => ({ UsersService: class {} }));
vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const userId = '123e4567-e89b-42d3-a456-426614174001';
const requestId = '123e4567-e89b-42d3-a456-426614174002';
const secret = 'unit-test-only-refresh-secret';

function fixture() {
  const error = new Error('database failure containing secret details');
  const prisma = { serializableTransaction: vi.fn().mockRejectedValue(error) };
  const logging = { application: vi.fn(), security: vi.fn() };
  type Dependencies = ConstructorParameters<typeof AuthService>;
  const service = new AuthService(
    {} as Dependencies[0],
    prisma as unknown as Dependencies[1],
    new ConfigService({ JWT_REFRESH_TOKEN_SECRET: secret }),
    logging as unknown as Dependencies[3],
  );
  return { service, prisma, logging, error };
}

describe('Auth application error logging', () => {
  it('logs final refresh failure with request ID and rethrows the same error', async () => {
    const { service, logging, error } = fixture();
    const token = jwt.sign({ sub: userId, jti: requestId }, secret, {
      expiresIn: 60,
    });
    await requestContext.run({ requestId }, async () => {
      await expect(service.refreshToken(token)).rejects.toBe(error);
    });
    expect(logging.application).toHaveBeenCalledExactlyOnceWith({
      event: 'auth.refresh_failed',
      requestContext: { requestId },
    });
    expect(logging.security).not.toHaveBeenCalled();
  });

  it.each(['invalid', 'expired'])(
    'excludes %s refresh tokens from application errors',
    async (kind) => {
      const { service, prisma, logging } = fixture();
      const token =
        kind === 'invalid'
          ? 'not-a-jwt'
          : jwt.sign({ sub: userId, jti: requestId }, secret, {
              expiresIn: -60,
            });
      await expect(service.refreshToken(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.serializableTransaction).not.toHaveBeenCalled();
      expect(logging.application).not.toHaveBeenCalled();
    },
  );

  it('logs logout-all failure without claiming success or exposing the error', async () => {
    const { service, logging, error } = fixture();
    await requestContext.run({ requestId }, async () => {
      await expect(service.logoutAll(userId)).rejects.toBe(error);
    });
    expect(logging.application).toHaveBeenCalledExactlyOnceWith({
      event: 'auth.logout_failed',
      userId,
      scope: 'all_sessions',
      requestContext: { requestId },
    });
    expect(logging.security).not.toHaveBeenCalled();
  });
});
