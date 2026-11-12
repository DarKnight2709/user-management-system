import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { EmailRateLimit } from '@/common/decorators/email-rate-limit.decorator.js';
import { IpRateLimit } from '@/common/decorators/ip-rate-limit.decorator.js';
import { Public } from '@/common/decorators/public.decorator.js';
import {
  FORGOT_PASSWORD_EMAIL_LIMIT,
  FORGOT_PASSWORD_EMAIL_WINDOW_MS,
  FORGOT_PASSWORD_IP_LIMIT,
  RESET_PASSWORD_IP_LIMIT,
} from './constants/account-security.constant.js';
import {
  ForgotPasswordDto,
  ResetPasswordDto,
} from './dto/password-reset.dto.js';
import { PasswordResetService } from './services/password-reset.service.js';

const FORGOT_PASSWORD_RESPONSE = {
  message: 'If the email belongs to an account, a reset link has been sent.',
};

@ApiTags('Auth')
@Controller('auth')
export class PasswordResetController {
  constructor(private readonly passwordReset: PasswordResetService) {}

  @Public()
  @IpRateLimit(FORGOT_PASSWORD_IP_LIMIT)
  @EmailRateLimit(FORGOT_PASSWORD_EMAIL_LIMIT, FORGOT_PASSWORD_EMAIL_WINDOW_MS)
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Email a password reset link to a registered address',
  })
  async forgotPassword(
    @Body() dto: ForgotPasswordDto,
    @Req() request: Request,
  ): Promise<typeof FORGOT_PASSWORD_RESPONSE> {
    await this.passwordReset.requestReset(
      dto.email,
      request.ip,
      request.get('user-agent'),
    );
    return FORGOT_PASSWORD_RESPONSE;
  }

  @Public()
  @IpRateLimit(RESET_PASSWORD_IP_LIMIT)
  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set a new password with a reset token' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.passwordReset.resetPassword(
      dto.token,
      dto.newPassword,
      request.ip,
      request.get('user-agent'),
    );
  }
}
