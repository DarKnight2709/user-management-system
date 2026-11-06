import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import jwt from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';
import type { RequestUser } from '@/common/decorators/current-user.decorator.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type { JwtRefreshTokenPayload } from '../interfaces/auth.interface.js';

/** Issues, verifies and persists access and refresh tokens. */
@Injectable()
export class TokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  generateAccessToken(user: RequestUser): string {
    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };

    return jwt.sign(
      payload,
      this.config.getOrThrow<string>('JWT_ACCESS_TOKEN_SECRET'),
      {
        algorithm: 'HS256',
        expiresIn: this.config.getOrThrow<number>(
          'JWT_ACCESS_TOKEN_EXPIRES_IN',
        ),
      },
    );
  }

  async generateRefreshToken(
    user: RequestUser,
    ipAddress?: string,
    userAgent?: string,
    manager?: Prisma.TransactionClient,
    existingFamilyId?: string,
    existingExpiresAt?: Date,
  ): Promise<string> {
    const jti = randomUUID();
    const refreshExpiresIn = this.config.getOrThrow<number>(
      'JWT_REFRESH_TOKEN_EXPIRES_IN',
    );
    // Rotation preserves the session deadline; only login starts a new lifetime.
    const expiresAtSeconds = existingExpiresAt
      ? Math.floor(existingExpiresAt.getTime() / 1000)
      : Math.floor(Date.now() / 1000) + refreshExpiresIn;
    if (expiresAtSeconds <= Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('Refresh token expired');
    }
    const payload = { sub: user.id, jti, exp: expiresAtSeconds };
    const refreshToken = jwt.sign(
      payload,
      this.config.getOrThrow<string>('JWT_REFRESH_TOKEN_SECRET'),
      { algorithm: 'HS256' },
    );
    const createData = {
      id: jti,
      userId: user.id,
      familyId: existingFamilyId ?? randomUUID(),
      refreshTokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(expiresAtSeconds * 1000),
      ipAddress,
      userAgent,
    };
    if (manager) {
      await manager.refreshToken.create({ data: createData });
    } else {
      await this.prisma.refreshToken.create({ data: createData });
    }
    return refreshToken;
  }

  verifyRefreshToken(
    token: string,
    options: { ignoreExpiration?: boolean } = {},
  ): JwtRefreshTokenPayload {
    const secret = this.config.getOrThrow<string>('JWT_REFRESH_TOKEN_SECRET');
    let payload: unknown;
    try {
      payload = jwt.verify(token, secret, {
        algorithms: ['HS256'],
        ignoreExpiration: options.ignoreExpiration ?? false,
      });
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError)
        throw new UnauthorizedException('Refresh token expired');
      if (error instanceof jwt.JsonWebTokenError)
        throw new UnauthorizedException('Invalid refresh token');
      throw error;
    }
    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('sub' in payload) ||
      typeof payload.sub !== 'string' ||
      !payload.sub.trim() ||
      !('jti' in payload) ||
      typeof payload.jti !== 'string' ||
      !payload.jti.trim() ||
      !('exp' in payload) ||
      typeof payload.exp !== 'number' ||
      !Number.isFinite(payload.exp) ||
      !('iat' in payload) ||
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat)
    ) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    return {
      sub: payload.sub,
      jti: payload.jti,
      exp: payload.exp,
      iat: payload.iat,
    };
  }

  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
