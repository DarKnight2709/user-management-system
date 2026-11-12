import { Injectable, UnauthorizedException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import type {
  AuthenticatedUser,
  TokenPair,
} from '../interfaces/auth.interface.js';
import { authRequestContext } from '../utils/auth-request-context.util.js';
import { matchesCredentialRef } from '../utils/credential-ref.util.js';
import { TokenService } from './token.service.js';

/** Refresh-session lifecycle: login, rotation with reuse detection, logout. */
@Injectable()
export class AuthSessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly logging: LoggingService,
  ) {}

  async login(
    user: AuthenticatedUser,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const familyId = randomUUID();
    const requestId = currentRequestId();
    const accessToken = this.tokens.generateAccessToken(user);
    const refreshToken = await this.prisma.serializableTransaction(
      async (manager) => {
        const activeUser = await manager.user.findUnique({
          where: { id: user.id, deletedAt: null },
        });
        if (!activeUser || this.passwordChangedSince(user, activeUser)) {
          throw new UnauthorizedException('Invalid credentials');
        }
        return this.tokens.generateRefreshToken(
          activeUser,
          ipAddress,
          userAgent,
          manager,
          familyId,
        );
      },
    );

    this.logging.security({
      action: 'auth.login.succeeded',
      actor: { type: 'USER', id: user.id },
      authMethod: 'PASSWORD',
      sessionRef: familyId,
      requestContext: { requestId, sourceIp: ipAddress, userAgent },
    });
    return { accessToken, refreshToken };
  }

  /** True when the password changed after these credentials were verified. */
  private passwordChangedSince(
    verified: AuthenticatedUser,
    current: { hashedPassword: string },
  ): boolean {
    return !matchesCredentialRef(
      current.hashedPassword,
      verified.credentialRef,
    );
  }

  async refreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    try {
      // 1. Verify JWT signature & expiration using HS256 secret key
      const payload = this.tokens.verifyRefreshToken(refreshToken);
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
            tokenEntity.refreshTokenHash !== this.tokens.hashToken(refreshToken)
          ) {
            throw new UnauthorizedException('Invalid refresh token');
          }

          // Return after revocation so it commits before the request is rejected.
          if (tokenEntity.revokedAt) {
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
          const newAccessToken = this.tokens.generateAccessToken(
            tokenEntity.user,
          );
          const newRefreshToken = await this.tokens.generateRefreshToken(
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
        this.logging.security({
          action: 'auth.refresh_token.reuse_detected',
          actor: { type: 'ANONYMOUS' },
          target: { type: 'USER', id: result.userId },
          sessionRef: result.sessionRef,
          requestContext: authRequestContext(ipAddress, userAgent),
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

      this.logging.application({
        event: 'auth.refresh_failed',
        requestContext: authRequestContext(ipAddress, userAgent),
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
    const payload = this.tokens.verifyRefreshToken(refreshToken, {
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
            token.refreshTokenHash !== this.tokens.hashToken(refreshToken)
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
        this.logging.application({
          event: 'auth.logout_session_failed',
          userId,
          scope: 'session_family',
          requestContext: authRequestContext(ipAddress, userAgent),
        });
      }
      throw error;
    }

    this.logging.security({
      action: 'auth.logout.completed',
      actor: { type: 'USER', id: userId },
      scope: 'SESSION_FAMILY',
      sessionRef,
      requestContext: authRequestContext(ipAddress, userAgent),
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
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
    } catch (error) {
      this.logging.application({
        event: 'auth.logout_failed',
        userId,
        scope: 'all_sessions',
        requestContext: authRequestContext(ipAddress, userAgent),
      });
      throw error;
    }

    this.logging.security({
      action: 'auth.logout.completed',
      actor: { type: 'USER', id: userId },
      scope: 'ALL_SESSIONS',
      requestContext: authRequestContext(ipAddress, userAgent),
    });
  }
}
