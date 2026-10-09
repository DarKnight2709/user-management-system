import type { Request } from 'express';
import { Req } from '@nestjs/common';
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
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard.js';
import {
  CurrentUser,
  type RequestUser,
} from '@/common/decorators/current-user.decorator.js';
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LoginDto, RefreshTokenDto, RegisterDto } from './dto/auth.dto.js';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @UseGuards(AuthGuard('local'))
  @Post('login')
  @ApiOperation({ summary: 'Log in with email and password' })
  @ApiBody({ type: LoginDto })
  async login(@CurrentUser() user: RequestUser, @Req() request: Request) {
    const ipAddress = request.ip;
    const userAgent = request.get('user-agent');
    return this.authService.login(user, ipAddress, userAgent);
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  @ApiBody({ type: RegisterDto })
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the refresh token family' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke all refresh tokens for the current user' })
  async logoutAll(@CurrentUser() user: RequestUser): Promise<void> {
    await this.authService.logoutAll(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get current authenticated user profile' })
  async getCurrentUser(@CurrentUser() user: RequestUser) {
    return user;
  }

  @Post('refresh-token')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token and issue new tokens' })
  async refresh(@Body() dto: RefreshTokenDto, @Req() request: Request) {
    return this.authService.refreshToken(
      dto.refreshToken,
      request.ip,
      request.get('user-agent'),
    );
  }
}
