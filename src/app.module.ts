import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { TestLifecycleModule } from './test-lifecycle/test-lifecycle.module.js';

@Module({
  imports: [TestLifecycleModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
