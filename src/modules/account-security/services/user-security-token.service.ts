import { randomUUID, createHash, createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@/generated/prisma/client.js';
import type { UserSecurityTokenType } from '@/generated/prisma/enums.js';
import { SECURITY_TOKEN_LINK_PATHS } from '../constants/account-security.constant.js';

const MIN_SECRET_LENGTH = 64;

/**
 * One-time tokens for account actions. The token is never stored: it is
 * derived from the row id with a secret, and only its SHA-256 is saved, so a
 * database leak alone cannot be used to reset anyone's password.
 */
@Injectable()
export class UserSecurityTokenService {
  constructor(private readonly config: ConfigService) {}

  tokenFor(type: UserSecurityTokenType, id: string): string {
    return createHmac('sha256', this.secret())
      .update(`${type}:${id}`)
      .digest('base64url');
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** Link for the frontend; the token sits in the fragment, out of access logs. */
  linkFor(type: UserSecurityTokenType, id: string): string {
    const url = new URL(
      SECURITY_TOKEN_LINK_PATHS[type],
      `${this.frontendOrigin()}/`,
    );
    url.hash = `token=${this.tokenFor(type, id)}`;
    return url.toString();
  }

  /**
   * Replaces any earlier token of this type for the user, so only the newest
   * link works and the table holds at most one row per user and type.
   */
  async issue(
    manager: Prisma.TransactionClient,
    userId: string,
    type: UserSecurityTokenType,
    lifetimeMs: number,
  ): Promise<{ id: string; expiresAt: Date }> {
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + lifetimeMs);

    await manager.userSecurityToken.deleteMany({ where: { userId, type } });
    await manager.userSecurityToken.create({
      data: {
        id,
        userId,
        type,
        tokenHash: this.hash(this.tokenFor(type, id)),
        expiresAt,
      },
    });
    return { id, expiresAt };
  }

  private frontendOrigin(): string {
    const origin = this.config.get<string>('FRONTEND_URL');
    if (!origin) {
      throw new ServiceUnavailableException(
        'Account link configuration is unavailable',
      );
    }
    return origin.replace(/\/+$/, '');
  }

  private secret(): string {
    const secret = this.config.get<string>('ACCOUNT_TOKEN_SECRET');
    if (!secret || secret.length < MIN_SECRET_LENGTH) {
      throw new ServiceUnavailableException(
        'Account token configuration is unavailable',
      );
    }
    return secret;
  }
}
