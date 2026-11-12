import type { Request } from 'express';
import { Req, SetMetadata } from '@nestjs/common';
import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { AuthSessionService } from './services/auth-session.service.js';
import { PasswordService } from './services/password.service.js';
import { AuthGuard } from '@nestjs/passport';
import {
  CurrentUser,
  type RequestUser,
} from '@/common/decorators/current-user.decorator.js';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LoginDto, RefreshTokenDto, RegisterDto } from './dto/auth.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginValidationGuard } from './guards/login-validation.guard.js';
import type { AuthenticatedUser } from './interfaces/auth.interface.js';
import { Public } from '@/common/decorators/public.decorator.js';
import { IpRateLimit } from '@/common/decorators/ip-rate-limit.decorator.js';
import { UserRateLimit } from '@/common/decorators/user-rate-limit.decorator.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessions: AuthSessionService,
    private readonly passwords: PasswordService,
  ) {}

  @UseGuards(LoginValidationGuard, AuthGuard('local'))
  @SetMetadata('loginAccountRateLimit', true)
  @Public()
  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiBody({ type: LoginDto })
  async login(@CurrentUser() user: AuthenticatedUser, @Req() request: Request) {
    const ipAddress = request.ip;
    const userAgent = request.get('user-agent');
    return this.sessions.login(user, ipAddress, userAgent);
  }

  @IpRateLimit(5)
  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterDto })
  async register(@Body() dto: RegisterDto, @Req() request: Request) {
    return this.authService.register(
      dto,
      request.ip,
      request.get('user-agent'),
    );
  }

  @IpRateLimit(10)
  @UserRateLimit(5)
  @Post('change-password')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Change your password and revoke refresh sessions' })
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() dto: ChangePasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.passwords.changePassword(
      userId,
      dto,
      request.ip,
      request.get('user-agent'),
    );
  }

  @Post('logout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the refresh token family' })
  async logout(
    @CurrentUser('id') userId: string,
    @Body() dto: RefreshTokenDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.sessions.logout(
      dto.refreshToken,
      userId,
      request.ip,
      request.get('user-agent'),
    );
  }

  @Post('logout-all')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke all refresh tokens for the current user' })
  async logoutAll(
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<void> {
    await this.sessions.logoutAll(
      user.id,
      request.ip,
      request.get('user-agent'),
    );
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  async getCurrentUser(@CurrentUser() user: RequestUser) {
    return user;
  }

  @Public()
  @IpRateLimit(60)
  @Post('refresh-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token and issue new tokens' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return this.sessions.refreshToken(
      dto.refreshToken,
      request.ip,
      request.get('user-agent'),
    );
  }
}
