import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '@/common/decorators/public.decorator.js';
import { HealthService } from './health.service.js';

@ApiTags('Health')
@Public()
@SkipThrottle({ ip: true, account: true, userId: true })
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get('live')
  @ApiOperation({ summary: 'Check whether the application can respond' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  @ApiOperation({ summary: 'Check PostgreSQL readiness' })
  ready(): Promise<{ status: 'ok'; checks: { database: 'up' } }> {
    return this.healthService.ready();
  }
}
