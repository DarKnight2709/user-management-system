import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { EmailModule } from '@/core/email/email.module.js';
import { ACCOUNT_EMAIL_QUEUE } from './constants/account-security.constant.js';
import { PasswordResetController } from './password-reset.controller.js';
import { AccountEmailQueueService } from './services/account-email-queue.service.js';
import { PasswordResetDeliveryService } from './services/password-reset-delivery.service.js';
import { PasswordResetService } from './services/password-reset.service.js';
import { UserSecurityTokenService } from './services/user-security-token.service.js';
import { AccountEmailWorker } from './workers/account-email.worker.js';

/** Email-based account recovery: password reset (email verification is next). */
@Module({
  imports: [
    BullModule.registerQueue({ name: ACCOUNT_EMAIL_QUEUE }),
    EmailModule,
  ],
  controllers: [PasswordResetController],
  providers: [
    UserSecurityTokenService,
    PasswordResetService,
    AccountEmailQueueService,
    PasswordResetDeliveryService,
    AccountEmailWorker,
  ],
})
export class AccountSecurityModule {}
