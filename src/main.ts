import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from '@nestjs/common';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true, // Buffer logs until the logger is set up
    // Without buffering, the early startup messages use Nest’s default logger
  });
  app.enableShutdownHooks();
  // Tell Nest to use that adapter for logging
  // registering WinstonModule creates the providers, but it doesn't automatically replace the default logger. We need to do that manually.
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);
  const swaggerEnabled =
    configService.get<string>('NODE_ENV') === 'development';

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle('User Management API')
      .setDescription('API documentation for User Management System')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api-docs', app, document);
  }

  await app.listen(port);

  const logger = new Logger('Bootstrap');
  logger.log(`Application is running on: http://localhost:${port}`);
  if (swaggerEnabled) {
    logger.log(`Swagger documentation: http://localhost:${port}/api-docs`);
  }
}
await bootstrap();
