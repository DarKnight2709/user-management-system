import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleInit,
  OnModuleDestroy,
  BeforeApplicationShutdown,
  OnApplicationShutdown,
} from '@nestjs/common';

@Injectable()
export class AppService
  implements
    OnModuleInit,
    OnApplicationBootstrap,
    OnModuleDestroy,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  onModuleInit() {
    console.log('🛠️ [AppService] -> Service đã khởi tạo xong (OnModuleInit)');
  }

  onApplicationBootstrap() {
    console.log(
      '🌟 [AppService] -> Toàn bộ ứng dụng đã chạy xong (OnApplicationBootstrap)',
    );
  }

  onModuleDestroy() {
    console.log('🧹 [AppService] -> onModuleDestroy: Dọn dẹp nội bộ');
  }

  beforeApplicationShutdown(signal?: string) {
    console.log(
      `⏳ [AppService] -> beforeApplicationShutdown: Nhận signal [${signal}]`,
    );
  }

  onApplicationShutdown(signal?: string) {
    console.log(
      `🛑 [AppService] -> onApplicationShutdown: Đã tắt hoàn toàn [${signal}]`,
    );
  }

  getHello(): string {
    return 'Hello World!';
  }
}
