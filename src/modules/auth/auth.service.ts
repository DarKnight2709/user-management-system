import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { compare, hash } from '@/common/utils/hash.util.js';
import { RequestUser } from '@/common/decorators/current-user.decorator.js';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core/database/prisma.service.js';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma } from '@/generated/prisma/client.js';
import jwt from 'jsonwebtoken';
import { RegisterDto } from './dto/auth.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoggingService } from '../logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';

export interface JwtRefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UsersService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly loggingService: LoggingService,
  ) {}
  async validateUser(email: string, password: string) {
    const user = await this.userService.findOneByEmail(email);
    if (!user) {
      this.logLoginFailure();
      throw new UnauthorizedException('Invalid credentials');
    }

    // compare password
    const isValidPassword = await compare(
      password,
      user.hashedPassword as string,
    );

    if (!isValidPassword) {
      this.logLoginFailure();
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
    };
  }

  async login(user: RequestUser, ipAddress?: string, userAgent?: string) {
    const familyId = randomUUID();
    const requestId = requestContext.getStore()?.requestId ?? randomUUID();
    const accessToken = this.generateAccessToken(user);
    const refreshToken = await this.prisma.serializableTransaction(
      async (manager) => {
        const activeUser = await manager.user.findUnique({
          where: { id: user.id, deletedAt: null },
        });
        if (!activeUser) throw new UnauthorizedException('Invalid credentials');
        return this.generateRefreshToken(
          activeUser,
          ipAddress,
          userAgent,
          manager,
          familyId,
        );
      },
    );

    this.loggingService.security({
      action: 'auth.login.succeeded',
      actor: {
        type: 'USER',
        id: user.id,
      },
      authMethod: 'PASSWORD',
      sessionRef: familyId,
      requestContext: {
        requestId,
        sourceIp: ipAddress,
        userAgent,
      },
    });
    return { accessToken, refreshToken };
  }

  async register(dto: RegisterDto, ipAddress?: string, userAgent?: string) {
    // Hash password
    const hashedPassword = await hash(dto.password);
    const emailInput = dto.email.trim().toLowerCase();
    const usernameInput = dto.username.trim().toLowerCase();

    // Create user
    const user = await this.userService.create({
      username: usernameInput,
      hashedPassword,
      firstName: dto.firstName,
      lastName: dto.lastName,
      birthDate: dto.birthDate,
      email: emailInput,
    });

    this.loggingService.security({
      action: 'auth.registration.succeeded',
      actor: { type: 'ANONYMOUS' },
      target: { type: 'USER', id: user.id },
      requestContext: {
        requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        sourceIp: ipAddress,
        userAgent,
      },
    });
  }

  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { hashedPassword: true },
    });
    if (!user) {
      throw new UnauthorizedException('Invalid current password');
    }

    const isCurrentPasswordValid = await compare(
      dto.currentPassword,
      user.hashedPassword,
    );
    if (!isCurrentPasswordValid) {
      this.loggingService.security({
        action: 'auth.password.change_failed',
        actor: { type: 'USER', id: userId },
        reasonCode: 'INVALID_CURRENT_PASSWORD',
        requestContext: {
          requestId: requestContext.getStore()?.requestId ?? randomUUID(),
          sourceIp: ipAddress,
          userAgent,
        },
      });
      throw new UnauthorizedException('Invalid current password');
    }

    const isSamePassword = await compare(dto.newPassword, user.hashedPassword);
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must differ from the current password',
      );
    }

    const hashedPassword = await hash(dto.newPassword);
    await this.prisma.serializableTransaction(async (manager) => {
      const updated = await manager.user.updateMany({
        where: {
          id: userId,
          deletedAt: null,
          hashedPassword: user.hashedPassword,
        },
        data: { hashedPassword },
      });
      if (updated.count !== 1) {
        throw new UnauthorizedException(
          'Account or password changed; authenticate again',
        );
      }
      await manager.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    this.loggingService.security({
      action: 'auth.password.changed',
      actor: { type: 'USER', id: userId },
      requestContext: {
        requestId: requestContext.getStore()?.requestId ?? randomUUID(),
      },
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
      const result = await this.prisma.serializableTransaction(
        async (manager) => {
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
            return {
              kind: 'reuse' as const,
              userId: tokenEntity.userId,
              sessionRef: tokenEntity.familyId,
            };
          }

          // Check token validity
          if (
            tokenEntity.user.deletedAt !== null ||
            tokenEntity.expiresAt <= new Date()
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
            new Date(
              Math.min(tokenEntity.expiresAt.getTime(), payload.exp * 1000),
            ),
          );

          return {
            kind: 'rotated' as const,
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
          };
        },
      );

      if (result.kind === 'reuse') {
        this.loggingService.security({
          action: 'auth.refresh_token.reuse_detected',
          actor: { type: 'ANONYMOUS' },
          target: { type: 'USER', id: result.userId },
          sessionRef: result.sessionRef,
          requestContext: {
            requestId: requestContext.getStore()?.requestId ?? randomUUID(),
            sourceIp: ipAddress,
            userAgent,
          },
        });
        throw new UnauthorizedException('Refresh token reuse detected');
      }
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
      };
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

      this.loggingService.application({
        event: 'auth.refresh_failed',
        requestContext: {
          requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        },
      });
      throw error;
    }
  }
  async logout(
    refreshToken: string,
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    if (!refreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Logout can revoke a session even after its token has expired.
    const payload = this.verifyRefreshToken(refreshToken, {
      ignoreExpiration: true,
    });
    if (payload.sub !== userId) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    let sessionRef: string | undefined;
    try {
      sessionRef = await this.prisma.serializableTransaction(
        async (manager) => {
          const token = await manager.refreshToken.findUnique({
            where: { id: payload.jti },
          });
          if (!token) return undefined;
          if (
            token.userId !== userId ||
            token.userId !== payload.sub ||
            token.refreshTokenHash !== this.hashToken(refreshToken)
          ) {
            throw new UnauthorizedException('Invalid refresh token');
          }
          await manager.refreshToken.updateMany({
            where: { familyId: token.familyId, revokedAt: null },
            data: { revokedAt: new Date() },
          });
          return token.familyId;
        },
      );
    } catch (error) {
      if (!(error instanceof UnauthorizedException)) {
        this.loggingService.application({
          event: 'auth.logout_session_failed',
          userId,
          scope: 'session_family',
          requestContext: {
            requestId: requestContext.getStore()?.requestId ?? randomUUID(),
          },
        });
      }
      throw error;
    }

    this.loggingService.security({
      action: 'auth.logout.completed',
      actor: { type: 'USER', id: userId },
      scope: 'SESSION_FAMILY',
      sessionRef,
      requestContext: {
        requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        sourceIp: ipAddress,
        userAgent,
      },
    });
  }

  async logoutAll(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    if (!userId) {
      throw new UnauthorizedException('Invalid user ID');
    }

    try {
      await this.prisma.serializableTransaction(async (manager) =>
        manager.refreshToken.updateMany({
          where: {
            userId,
            revokedAt: null,
          },
          data: { revokedAt: new Date() },
        }),
      );
    } catch (error) {
      this.loggingService.application({
        event: 'auth.logout_failed',
        userId,
        scope: 'all_sessions',
        requestContext: {
          requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        },
      });
      throw error;
    }

    this.loggingService.security({
      action: 'auth.logout.completed',
      actor: { type: 'USER', id: userId },
      scope: 'ALL_SESSIONS',
      requestContext: {
        requestId: requestContext.getStore()?.requestId ?? randomUUID(),
        sourceIp: ipAddress,
        userAgent,
      },
    });
  }

  // HELPERS

  private verifyRefreshToken(
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

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private async generateRefreshToken(
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
      {
        algorithm: 'HS256',
      },
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

  private logLoginFailure(): void {
    const requestId = requestContext.getStore()?.requestId ?? randomUUID();

    this.loggingService.security({
      action: 'auth.login.failed',
      actor: { type: 'ANONYMOUS' },
      authMethod: 'PASSWORD',
      reasonCode: 'INVALID_CREDENTIALS',
      requestContext: { requestId },
    });
  }
}
