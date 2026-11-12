import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EmailModule } from '@/core/email/email.module.js';
import { ACCOUNT_EMAIL_QUEUE } from './constants/account-security.constant.js';
import { EmailVerificationController } from './email-verification.controller.js';
import { PasswordResetController } from './password-reset.controller.js';
import { AccountEmailQueueService } from './services/account-email-queue.service.js';
import { EmailVerificationService } from './services/email-verification.service.js';
import { PasswordResetService } from './services/password-reset.service.js';
import { SecurityTokenEmailDeliveryService } from './services/security-token-email-delivery.service.js';
import { UserSecurityTokenService } from './services/user-security-token.service.js';
import { AccountEmailWorker } from './workers/account-email.worker.js';

/** Email-based account recovery and proof of address: password reset and email verification. */
@Module({
  imports: [
    BullModule.registerQueue({ name: ACCOUNT_EMAIL_QUEUE }),
    EmailModule,
  ],
  controllers: [PasswordResetController, EmailVerificationController],
  providers: [
    UserSecurityTokenService,
    PasswordResetService,
    EmailVerificationService,
    AccountEmailQueueService,
    SecurityTokenEmailDeliveryService,
    AccountEmailWorker,
  ],
  // Registration and profile updates start a verification from their own modules.
  exports: [EmailVerificationService],
})
export class AccountSecurityModule {}
