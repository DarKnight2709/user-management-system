import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import type { Prisma } from '@/generated/prisma/client.js';
import { TokenService } from '../services/token.service.js';

vi.mock('@/core/database/prisma.service.js', () => ({
  PrismaService: class {},
}));

const ACCESS_SECRET = 'unit-test-only-access-secret';
const REFRESH_SECRET = 'unit-test-only-refresh-secret';
const user = { id: 'user-id', username: 'alice', email: 'alice@example.com' };

function setup() {
  const prisma = {
    refreshToken: { create: vi.fn().mockResolvedValue({}) },
  };
  const manager = { refreshToken: { create: vi.fn().mockResolvedValue({}) } };
  const service = new TokenService(
    prisma as never,
    new ConfigService({
      JWT_ACCESS_TOKEN_SECRET: ACCESS_SECRET,
      JWT_ACCESS_TOKEN_EXPIRES_IN: 900,
      JWT_REFRESH_TOKEN_SECRET: REFRESH_SECRET,
      JWT_REFRESH_TOKEN_EXPIRES_IN: 3600,
    }),
  );
  return {
    service,
    prisma,
    manager,
    tx: manager as unknown as Prisma.TransactionClient,
  };
}

const signRefresh = (claims: object, secret = REFRESH_SECRET) =>
  // nosemgrep: javascript.jsonwebtoken.security.jwt-hardcode.hardcoded-jwt-secret
  jwt.sign(claims, secret, { algorithm: 'HS256' });

describe('TokenService.generateAccessToken', () => {
  it('signs identity claims with the access secret and configured lifetime', () => {
    const { service } = setup();

    const token = service.generateAccessToken(user);

    const payload = jwt.verify(token, ACCESS_SECRET, {
      algorithms: ['HS256'],
    }) as jwt.JwtPayload;
    expect(payload).toMatchObject({
      sub: user.id,
      username: user.username,
      email: user.email,
    });
    expect(payload.exp! - payload.iat!).toBe(900);
  });

  it('is not verifiable with the refresh secret', () => {
    const { service } = setup();

    expect(() =>
      jwt.verify(service.generateAccessToken(user), REFRESH_SECRET),
    ).toThrow();
  });
});

describe('TokenService.generateRefreshToken', () => {
  it('persists the hash, family and expiry through the supplied transaction', async () => {
    const { service, manager, prisma, tx } = setup();

    const token = await service.generateRefreshToken(
      user,
      '10.0.0.1',
      'agent',
      tx,
    );

    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    const { data } = manager.refreshToken.create.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    const payload = service.verifyRefreshToken(token);
    expect(data).toMatchObject({
      id: payload.jti,
      userId: user.id,
      refreshTokenHash: service.hashToken(token),
      ipAddress: '10.0.0.1',
      userAgent: 'agent',
      expiresAt: new Date(payload.exp * 1000),
    });
    expect(typeof data.familyId).toBe('string');
  });

  it('falls back to the shared client without a transaction', async () => {
    const { service, prisma, manager } = setup();

    await service.generateRefreshToken(user);

    expect(prisma.refreshToken.create).toHaveBeenCalledOnce();
    expect(manager.refreshToken.create).not.toHaveBeenCalled();
  });

  it('keeps an existing family and deadline on rotation', async () => {
    const { service, manager, tx } = setup();
    const deadline = new Date(Math.floor(Date.now() / 1000) * 1000 + 120_000);

    const token = await service.generateRefreshToken(
      user,
      undefined,
      undefined,
      tx,
      'family-1',
      deadline,
    );

    const { data } = manager.refreshToken.create.mock.calls[0][0] as {
      data: { familyId: string; expiresAt: Date };
    };
    expect(data.familyId).toBe('family-1');
    expect(data.expiresAt).toEqual(deadline);
    expect(service.verifyRefreshToken(token).exp).toBe(
      deadline.getTime() / 1000,
    );
  });

  it('refuses to issue a token whose deadline already passed', async () => {
    const { service, manager, tx } = setup();

    await expect(
      service.generateRefreshToken(
        user,
        undefined,
        undefined,
        tx,
        'family-1',
        new Date(Date.now() - 5_000),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(manager.refreshToken.create).not.toHaveBeenCalled();
  });

  it('issues a distinct token id every time', async () => {
    const { service } = setup();

    const first = service.verifyRefreshToken(
      await service.generateRefreshToken(user),
    );
    const second = service.verifyRefreshToken(
      await service.generateRefreshToken(user),
    );

    expect(first.jti).not.toBe(second.jti);
  });
});

describe('TokenService.verifyRefreshToken', () => {
  const claims = () => ({
    sub: 'user-id',
    jti: 'token-id',
    exp: Math.floor(Date.now() / 1000) + 60,
  });

  it('returns only the validated claims', () => {
    const { service } = setup();

    expect(
      service.verifyRefreshToken(signRefresh({ ...claims(), extra: 'x' })),
    ).toEqual({
      sub: 'user-id',
      jti: 'token-id',
      exp: expect.any(Number),
      iat: expect.any(Number),
    });
  });

  it('rejects tokens signed with another secret', () => {
    const { service } = setup();

    expect(() =>
      service.verifyRefreshToken(signRefresh(claims(), ACCESS_SECRET)),
    ).toThrow('Invalid refresh token');
  });

  it('rejects malformed tokens', () => {
    const { service } = setup();

    expect(() => service.verifyRefreshToken('not-a-jwt')).toThrow(
      'Invalid refresh token',
    );
  });

  it('rejects other algorithms', () => {
    const { service } = setup();
    const token = jwt.sign(claims(), REFRESH_SECRET, { algorithm: 'HS512' });

    expect(() => service.verifyRefreshToken(token)).toThrow(
      'Invalid refresh token',
    );
  });

  it.each([
    ['sub', { jti: 'token-id' }],
    ['jti', { sub: 'user-id' }],
    ['blank sub', { sub: '  ', jti: 'token-id' }],
    ['blank jti', { sub: 'user-id', jti: '' }],
    ['numeric sub', { sub: 5, jti: 'token-id' }],
  ])('rejects tokens missing a valid %s', (_, partial) => {
    const { service } = setup();
    const token = signRefresh({
      exp: Math.floor(Date.now() / 1000) + 60,
      ...partial,
    });

    expect(() => service.verifyRefreshToken(token)).toThrow(
      'Invalid refresh token',
    );
  });

  it('reports expired tokens, unless expiry is ignored', () => {
    const { service } = setup();
    const token = signRefresh({
      ...claims(),
      exp: Math.floor(Date.now() / 1000) - 60,
    });

    expect(() => service.verifyRefreshToken(token)).toThrow(
      'Refresh token expired',
    );
    expect(
      service.verifyRefreshToken(token, { ignoreExpiration: true }).jti,
    ).toBe('token-id');
  });
});

describe('TokenService.hashToken', () => {
  it('is a stable SHA-256 hex digest', () => {
    const { service } = setup();

    expect(service.hashToken('abc')).toBe(
      createHash('sha256').update('abc').digest('hex'),
    );
    expect(service.hashToken('abc')).toHaveLength(64);
    expect(service.hashToken('abc')).not.toBe(service.hashToken('abd'));
  });
});
