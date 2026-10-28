import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { UsersModule } from '../users/users.module.js';
import { LocalStrategy } from './strategies/local.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';
import { LoggingModule } from '../logging/logging.module.js';

@Module({
  imports: [UsersModule, PassportModule, ThrottlerModule, LoggingModule],
  controllers: [AuthController],
  providers: [AuthService, LocalStrategy, JwtStrategy],
})
export class AuthModule {}
