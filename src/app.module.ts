import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { UsersModule } from './modules/users/users.module.js';
import { LoggerMiddleware } from './common/middlewares/logger.middleware.js';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { TransformInterceptor } from './common/interceptors/transform.interceptor.js';
import { InputValidationPipe } from './common/pipes/validation.pipe.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { GlobalModule } from './modules/global/global.module.js';
import { PrismaClientExceptionFilter } from './common/filters/prisma-exception.filter.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { ThrottlerModule } from '@nestjs/throttler';
import { CustomThrottlerGuard } from './common/guards/custom-throttler.guard.js';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './common/guards/permissions.guard.js';
import { HealthModule } from './modules/health/health.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WinstonModule, utilities as nestWinstonUtilities } from 'nest-winston';
import * as winston from 'winston';
import { requestContext } from './core/logging/request-context.js';
import { redactSensitiveData } from './core/logging/redact-log.format.js';
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        prefix: config.get<string>('REDIS_QUEUE_PREFIX'),
        connection: {
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
        },
      }),
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/static',
    }),
    // ThrottlerModule registers the policies and storage
    // The policies will be implemented in ascending ttl order
    ThrottlerModule.forRoot([
      { name: 'ip', ttl: 60_000, limit: 20 },
      { name: 'account', ttl: 60_000, limit: 5 },
      { name: 'userId', ttl: 60_000, limit: 5 },
    ]),
    // accept the same options object as createLogger()
    WinstonModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const service = configService.get<string>(
          'SERVICE_NAME',
          'backend-api',
        );
        const isDevelopment =
          configService.get<string>('NODE_ENV') === 'development';
        const addRequestId = winston.format((info) => {
          const context = requestContext.getStore();
          if (context && context.requestId) {
            info.requestId = context.requestId;
          }
          return info;
        });

        return {
          level: configService.get<string>('LOG_LEVEL', 'info'),
          defaultMeta: { service },
          format: winston.format.combine(
            addRequestId(),
            redactSensitiveData(),
            winston.format.timestamp(),
            isDevelopment
              ? winston.format.combine(
                  winston.format.ms(),
                  nestWinstonUtilities.format.nestLike(service, {
                    colors: !process.env.NO_COLOR,
                    prettyPrint: true,
                    processId: true,
                    appName: true,
                  }),
                )
              : winston.format.json(),
          ),
          transports: [new winston.transports.Console()],
        };
      },
    }),
    UsersModule,
    GlobalModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
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
    {
      provide: APP_FILTER,
      useClass: PrismaClientExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LoggerMiddleware).forRoutes('*');
  }
}
