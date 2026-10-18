import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailNotificationWorker } from './workers/email-notification.worker.js';
import { EmailService } from './services/email.service.js';
import { InvitationDeliveryService } from './services/invitation-delivery.service.js';
import { InvitationLinksService } from './services/invitation-links.service.js';
import { INVITATION_EMAIL_QUEUE } from './constants/email-queue.constant.js';
import { QueueDashboardModule } from '@/core/queues/queue-dashboard.module.js';

@Module({
  imports: [
    BullModule.registerQueue({ name: INVITATION_EMAIL_QUEUE }),
    QueueDashboardModule.register(),
  ],
  providers: [
    EmailNotificationWorker,
    EmailService,
    InvitationDeliveryService,
    InvitationLinksService,
  ],
  exports: [BullModule],
})
export class InvitationQueueModule {}
