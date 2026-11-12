import type { RequestUser } from '@/common/decorators/current-user.decorator.js';

/** Identity returned by credential validation, bound to the password it matched. */
export interface AuthenticatedUser extends RequestUser {
  credentialRef: string;
}

export interface JwtRefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}
