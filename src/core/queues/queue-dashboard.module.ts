import { Module, type DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { INVITATION_EMAIL_QUEUE } from '@/modules/organizations/invitations/constants/email-queue.constant.js';

@Module({})
export class QueueDashboardModule {
  static async register(): Promise<DynamicModule> {
    // Module imports execute before bootstrap: wait for .env and validation first.
    await ConfigModule.envVariablesLoaded;
    return this.forEnvironment(process.env.NODE_ENV);
  }

  static forEnvironment(environment: string | undefined): DynamicModule {
    if (environment !== 'development') {
      return { module: QueueDashboardModule };
    }

    return {
      module: QueueDashboardModule,
      imports: [
        BullBoardModule.forRoot({
          route: '/queues',
          adapter: ExpressAdapter,
        }),
        BullBoardModule.forFeature({
          name: INVITATION_EMAIL_QUEUE,
          adapter: BullMQAdapter,
          options: { readOnlyMode: true },
        }),
      ],
    };
  }
}
