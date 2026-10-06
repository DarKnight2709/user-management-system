import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { compare, hash } from '@/common/utils/hash.util.js';
import { RequestUser } from '@/common/decorators/current-user.decorator.js';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core/database/prisma.service.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client.js';
import jwt from 'jsonwebtoken';
import { RegisterDto } from './dto/auth.dto.js';

export interface JwtRefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    private readonly userService: UsersService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}
  async validateUser(email: string, password: string) {
    const user = await this.userService.findOneByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // compare password
    const isValidPassword = await compare(
      password,
      user.hashedPassword as string,
    );

    if (!isValidPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
    };
  }

  async login(user: RequestUser, ipAddress?: string, userAgent?: string) {
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.prisma.$transaction(async (manager) => {
      const activeUser = await manager.user.findUnique({
        where: { id: user.id, deletedAt: null },
      });
      if (!activeUser) throw new UnauthorizedException('Invalid credentials');
      return this.generateRefreshToken(
        activeUser,
        ipAddress,
        userAgent,
        manager,
      );
    });
    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto) {
    // Hash password
    const hashedPassword = await hash(dto.password);
    const emailInput = dto.email.trim().toLowerCase();
    const usernameInput = dto.username.trim().toLowerCase();

    // Create user
    await this.userService.create({
      username: usernameInput,
      hashedPassword,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthDate: dto.birthDate,
      email: emailInput,
    });
  }

  async refreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    try {
      // 1. Verify JWT signature & expiration using HS256 secret key
      const payload = this.verifyRefreshToken(refreshToken);

      const jti = payload.jti;

      // 2. Perform rotation in a single transaction
      const result = await this.prisma.$transaction(async (manager) => {
        const tokenEntity = await manager.refreshToken.findUnique({
          where: { id: jti },
          include: { user: true },
        });

        if (
          !tokenEntity ||
          tokenEntity.userId !== payload.sub ||
          tokenEntity.refreshTokenHash !== this.hashToken(refreshToken)
        ) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        // Return after revocation so it commits before the request is rejected.
        if (tokenEntity?.revokedAt) {
          await manager.refreshToken.updateMany({
            where: { familyId: tokenEntity.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return null;
        }

        // Check token validity
        if (
          tokenEntity.user.deletedAt !== null ||
          tokenEntity.expiresAt <= new Date() ||
          (ipAddress && tokenEntity.ipAddress !== ipAddress) ||
          (userAgent && tokenEntity.userAgent !== userAgent)
        ) {
          throw new UnauthorizedException('Invalid refresh token');
        }

        // Revoke current token
        const now = new Date();
        const consumed = await manager.refreshToken.updateMany({
          where: { id: jti, revokedAt: null, expiresAt: { gt: now } },
          data: { revokedAt: now },
        });
        if (consumed.count !== 1)
          throw new UnauthorizedException('Invalid refresh token');

        // Generate new pair
        const newAccessToken = this.generateAccessToken(tokenEntity.user);
        const newRefreshToken = await this.generateRefreshToken(
          tokenEntity.user,
          ipAddress,
          userAgent,
          manager,
          tokenEntity.familyId,
        );

        return {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
        };
      });

      if (!result) {
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      return result;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedException('Refresh token expired');
      }
      if (error instanceof jwt.JsonWebTokenError) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.error('Refresh token verification failed:', error);
      throw error;
    }
  }
  async logout(refreshToken: string): Promise<void> {
    if (!refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const payload = this.verifyRefreshToken(refreshToken);
    await this.prisma.$transaction(async (manager) => {
      const token = await manager.refreshToken.findUnique({
        where: { id: payload.jti },
      });
      if (
        !token ||
        token.userId !== payload.sub ||
        token.refreshTokenHash !== this.hashToken(refreshToken)
      ) {
        throw new UnauthorizedException('Invalid refresh token');
      }
      await manager.refreshToken.updateMany({
        where: { familyId: token.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }

  async logoutAll(userId: string): Promise<void> {
    if (!userId) {
      throw new UnauthorizedException('Invalid user ID');
    }

    try {
      await this.prisma.$transaction(async (manager) =>
        manager.refreshToken.updateMany({
          where: {
            userId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Logout all sessions failed for userId: ${userId}`,
        error,
      );
      throw error;
    }
  }

  // HELPERS

  private verifyRefreshToken(token: string): JwtRefreshTokenPayload {
    const secret = this.config.getOrThrow<string>('JWT_REFRESH_TOKEN_SECRET');
    let payload: unknown;
    try {
      payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async generateRefreshToken(
    user: RequestUser,
    ipAddress?: string,
    userAgent?: string,
    manager?: Prisma.TransactionClient,
    existingFamilyId?: string,
  ): Promise<string> {
    const jti = randomUUID();
    const refreshExpiresIn = this.config.getOrThrow<number>(
      'JWT_REFRESH_TOKEN_EXPIRES_IN',
    );
    const payload = { sub: user.id, jti };
    const refreshToken = jwt.sign(
      payload,
      this.config.getOrThrow<string>('JWT_REFRESH_TOKEN_SECRET'),
      {
        algorithm: 'HS256',
        expiresIn: refreshExpiresIn,
      },
    );
    const createData = {
      id: jti,
      userId: user.id,
      familyId: existingFamilyId ?? randomUUID(),
      refreshTokenHash: this.hashToken(refreshToken),
      expiresAt: new Date(Date.now() + refreshExpiresIn * 1000),
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

  private generateAccessToken(user: RequestUser): string {
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
}
