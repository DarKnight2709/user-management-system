import { Module } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { AuthSessionService } from './services/auth-session.service.js';
import { PasswordService } from './services/password.service.js';
import { RefreshTokenCleanupService } from './services/refresh-token-cleanup.service.js';
import { TokenService } from './services/token.service.js';
import { UsersModule } from '../users/users.module.js';
import { LocalStrategy } from './strategies/local.strategy.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';
import { PassportModule } from '@nestjs/passport';
import { ThrottlerModule } from '@nestjs/throttler';

@Module({
  imports: [UsersModule, PassportModule, ThrottlerModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthSessionService,
    PasswordService,
    RefreshTokenCleanupService,
    TokenService,
    LocalStrategy,
    JwtStrategy,
  ],
})
export class AuthModule {}
