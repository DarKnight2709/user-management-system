import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { IpRateLimit } from '@/common/decorators/ip-rate-limit.decorator.js';
import { Public } from '@/common/decorators/public.decorator.js';
import { UserRateLimit } from '@/common/decorators/user-rate-limit.decorator.js';
import {
  RESEND_VERIFICATION_IP_LIMIT,
  RESEND_VERIFICATION_USER_LIMIT,
  RESEND_VERIFICATION_WINDOW_MS,
  VERIFY_EMAIL_IP_LIMIT,
} from './constants/account-security.constant.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { EmailVerificationService } from './services/email-verification.service.js';

const RESEND_VERIFICATION_RESPONSE = {
  message: 'If your email is not verified yet, a new link has been sent.',
};

@ApiTags('Auth')
@Controller('auth')
export class EmailVerificationController {
  constructor(private readonly verification: EmailVerificationService) {}

  @Public()
  @IpRateLimit(VERIFY_EMAIL_IP_LIMIT)
  @Post('verify-email')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Verify the email address with an emailed token' })
  async verifyEmail(
    @Body() dto: VerifyEmailDto,
    @Req() request: Request,
  ): Promise<void> {
    await this.verification.verify(
      dto.token,
      request.ip,
      request.get('user-agent'),
    );
  }

  @IpRateLimit(RESEND_VERIFICATION_IP_LIMIT)
  @UserRateLimit(RESEND_VERIFICATION_USER_LIMIT, RESEND_VERIFICATION_WINDOW_MS)
  @Post('resend-verification')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Email a new verification link to the signed-in user',
  })
  async resendVerification(
    @CurrentUser('id') userId: string,
  ): Promise<typeof RESEND_VERIFICATION_RESPONSE> {
    await this.verification.resend(userId);
    return RESEND_VERIFICATION_RESPONSE;
  }
}
