import { Module } from '@nestjs/common';
import { EmailService } from './email.service.js';

/** The single SMTP transport shared by every module that sends email. */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
