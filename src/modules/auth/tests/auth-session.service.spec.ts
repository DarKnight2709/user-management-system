import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { createPrismaStub } from '../../../../test/support/prisma-stub.js';
import { AuthSessionService } from '../services/auth-session.service.js';
import { TokenService } from '../services/token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const user = {
  id: '123e4567-e89b-42d3-a456-426614174001',
  username: 'alice',
  email: 'alice@example.com',
};

function setup() {
  const manager = {
    user: { findUnique: vi.fn().mockResolvedValue({ ...user }) },
    refreshToken: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  const prisma = createPrismaStub(manager);
  const tokens = new TokenService(
    prisma,
    new ConfigService({
      JWT_ACCESS_TOKEN_SECRET: 'unit-test-only-access-secret',
      JWT_ACCESS_TOKEN_EXPIRES_IN: 900,
      JWT_REFRESH_TOKEN_SECRET: 'unit-test-only-refresh-secret',
      JWT_REFRESH_TOKEN_EXPIRES_IN: 3600,
    }),
  );
  const logging = { security: vi.fn(), application: vi.fn() };
  const service = new AuthSessionService(
    prisma,
    tokens,
    logging as unknown as LoggingService,
  );
  return { service, manager, tokens, logging };
}

/** Issues a real refresh token and the row the database would hold for it. */
async function issuedSession(
  ctx: ReturnType<typeof setup>,
  overrides: Record<string, unknown> = {},
) {
  const token = await ctx.tokens.generateRefreshToken(
    user,
    undefined,
    undefined,
    ctx.manager as never,
    'family-1',
  );
  const payload = ctx.tokens.verifyRefreshToken(token);
  const entity = {
    id: payload.jti,
    userId: user.id,
    familyId: 'family-1',
    refreshTokenHash: ctx.tokens.hashToken(token),
    expiresAt: new Date(payload.exp * 1000),
    revokedAt: null,
    user: { ...user, deletedAt: null },
    ...overrides,
  };
  ctx.manager.refreshToken.findUnique.mockResolvedValue(entity);
  ctx.manager.refreshToken.create.mockClear();
  return { token, payload, entity };
}

describe('AuthSessionService.login', () => {
  it('rejects accounts deleted after credential validation', async () => {
    const ctx = setup();
    ctx.manager.user.findUnique.mockResolvedValue(null);

    await expect(ctx.service.login(user)).rejects.toMatchObject({
      status: 401,
    });
    expect(ctx.manager.refreshToken.create).not.toHaveBeenCalled();
    expect(ctx.logging.security).not.toHaveBeenCalled();
  });

  it('starts a new session family and logs the success', async () => {
    const ctx = setup();

    const pair = await ctx.service.login(user, '10.0.0.1', 'agent');

    expect(pair.accessToken).toBeTruthy();
    const { data } = ctx.manager.refreshToken.create.mock.calls[0][0] as {
      data: { familyId: string; userId: string };
    };
    expect(data.userId).toBe(user.id);
    expect(ctx.logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.login.succeeded',
        actor: { type: 'USER', id: user.id },
        sessionRef: data.familyId,
        requestContext: expect.objectContaining({
          sourceIp: '10.0.0.1',
          userAgent: 'agent',
        }),
      }),
    );
  });
});

describe('AuthSessionService.refreshToken', () => {
  it('requires a token', async () => {
    const { service } = setup();

    await expect(service.refreshToken('')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects tokens with no stored row', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx);
    ctx.manager.refreshToken.findUnique.mockResolvedValue(null);

    await expect(ctx.service.refreshToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a row whose stored hash does not match the presented token', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, {
      refreshTokenHash: 'different',
    });

    await expect(ctx.service.refreshToken(token)).rejects.toMatchObject({
      status: 401,
    });
    expect(ctx.manager.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a row that belongs to another user', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, { userId: randomUUID() });

    await expect(ctx.service.refreshToken(token)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('revokes the whole family and logs when a revoked token is replayed', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, { revokedAt: new Date() });

    await expect(ctx.service.refreshToken(token)).rejects.toThrow(
      'Refresh token reuse detected',
    );

    expect(ctx.manager.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(ctx.logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.refresh_token.reuse_detected',
        target: { type: 'USER', id: user.id },
        sessionRef: 'family-1',
      }),
    );
  });

  it('rejects tokens of deleted users', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, {
      user: { ...user, deletedAt: new Date() },
    });

    await expect(ctx.service.refreshToken(token)).rejects.toMatchObject({
      status: 401,
    });
    expect(ctx.manager.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rejects when the compare-and-revoke loses a concurrent race', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx);
    ctx.manager.refreshToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(ctx.service.refreshToken(token)).rejects.toMatchObject({
      status: 401,
    });
    expect(ctx.manager.refreshToken.create).not.toHaveBeenCalled();
  });

  it('rotates inside the same family without extending the deadline', async () => {
    const ctx = setup();
    const { token, payload } = await issuedSession(ctx);

    const pair = await ctx.service.refreshToken(token);

    expect(pair.refreshToken).not.toBe(token);
    const { data } = ctx.manager.refreshToken.create.mock.calls[0][0] as {
      data: { familyId: string; expiresAt: Date };
    };
    expect(data.familyId).toBe('family-1');
    expect(data.expiresAt.getTime()).toBeLessThanOrEqual(payload.exp * 1000);
    expect(ctx.manager.refreshToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: payload.jti,
        revokedAt: null,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it('does not log rejected tokens as application failures', async () => {
    const ctx = setup();

    await expect(ctx.service.refreshToken('garbage')).rejects.toBeDefined();

    expect(ctx.logging.application).not.toHaveBeenCalled();
  });
});

describe('AuthSessionService.logout', () => {
  it('requires a token', async () => {
    const { service } = setup();

    await expect(service.logout('', user.id)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('rejects a token issued to another user', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx);

    await expect(ctx.service.logout(token, randomUUID())).rejects.toMatchObject(
      { status: 401 },
    );
    expect(ctx.manager.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a token whose stored hash differs', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, { refreshTokenHash: 'other' });

    await expect(ctx.service.logout(token, user.id)).rejects.toMatchObject({
      status: 401,
    });
    expect(ctx.manager.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('revokes the family and logs the completed logout', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx);

    await ctx.service.logout(token, user.id);

    expect(ctx.manager.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { familyId: 'family-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(ctx.logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout.completed',
        scope: 'SESSION_FAMILY',
        sessionRef: 'family-1',
      }),
    );
  });

  it('completes quietly when the token row no longer exists', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx);
    ctx.manager.refreshToken.findUnique.mockResolvedValue(null);

    await expect(ctx.service.logout(token, user.id)).resolves.toBeUndefined();
    expect(ctx.manager.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it('accepts an expired token so users can still log out', async () => {
    const ctx = setup();
    const { token } = await issuedSession(ctx, {
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(ctx.service.logout(token, user.id)).resolves.toBeUndefined();
  });
});

describe('AuthSessionService.logoutAll', () => {
  it('rejects a missing user id', async () => {
    const { service } = setup();

    await expect(service.logoutAll('')).rejects.toMatchObject({ status: 401 });
  });

  it('revokes every active token of the user and logs it', async () => {
    const ctx = setup();

    await ctx.service.logoutAll(user.id, '10.0.0.1');

    expect(ctx.manager.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(ctx.logging.security).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.logout.completed',
        scope: 'ALL_SESSIONS',
      }),
    );
  });
});
