import { applyDecorators, SetMetadata } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

export const UserRateLimit = (limit: number, ttl: number = 60_000) =>
  applyDecorators(
    SetMetadata('userIdRateLimit', true),
    Throttle({ userId: { limit, ttl } }),
  );
