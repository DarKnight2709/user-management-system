import { Module } from '@nestjs/common';
import { TestLifecycleController } from './test-lifecycle.controller.js';
import { TestLifecycleService } from './test-lifecycle.service.js';

@Module({
  controllers: [TestLifecycleController],
  providers: [TestLifecycleService],
  exports: [TestLifecycleService],
})
export class TestLifecycleModule {}
