import {
  Injectable,
  OnModuleInit,
  OnApplicationBootstrap,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';

@Injectable()
export class TestLifecycleService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  onModuleInit() {
    console.log(
      '🛠️ [TestLifecycleModule] -> Service đã khởi tạo xong (OnModuleInit)',
    );
  }

  onApplicationBootstrap() {
    console.log(
      '🌟 [TestLifecycleModule] -> Toàn bộ ứng dụng đã chạy hoàn tất (OnApplicationBootstrap)',
    );
  }

  onModuleDestroy() {
    // clean up internal module (clear timers, destroy subscription RxJS, close stream file).
    console.log('🧹 [TestLifecycleService] -> onModuleDestroy: Dọn dẹp nội bộ');
  }

  beforeApplicationShutdown(signal?: string) {
    // Before the server closes connection (stop receiving new requests, and finishes the existing requests)
    console.log(
      `⏳ [TestLifecycleService] -> beforeApplicationShutdown: Nhận signal [${signal}]`,
    );
  }

  onApplicationShutdown(signal?: string) {
    // After the server closes connection (stop receiving new requests, and finishes the existing requests)
    // -> Clean up global application (destroy connection DB, close server, close Redis, or flush logs ra file)

    console.log(
      `🛑 [TestLifecycleService] -> onApplicationShutdown: Đã tắt hoàn toàn [${signal}]`,
    );
  }
}
