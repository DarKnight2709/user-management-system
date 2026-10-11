import { Throttle } from '@nestjs/throttler';

export const IpRateLimit = (limit: number, ttl: number = 60_000) =>
  Throttle({ ip: { limit, ttl } });
