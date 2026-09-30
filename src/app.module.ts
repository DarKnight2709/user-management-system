import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { UsersModule } from './modules/users/users.module.js';
import { LoggerMiddleware } from './common/middlewares/logger.middleware.js';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { InputValidationPipe } from './common/pipes/validation.pipe.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { GlobalModule } from './modules/global/global.module.js';

@Module({
  imports: [UsersModule, GlobalModule],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: TransformInterceptor,
    },
    {
      provide: APP_PIPE,
      useClass: InputValidationPipe,
    },
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
