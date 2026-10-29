import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service.js';
import { S3Service } from '../../core/storage/s3.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { ConfigModule } from '@nestjs/config';
import { envValidationSchema } from '@/core/config/env.validation.js';
import { LoggingModule } from '@/modules/logging/logging.module.js';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: envValidationSchema,
    }),
    LoggingModule,
  ],
  providers: [PrismaService, S3Service, PermissionsService],
  exports: [PrismaService, S3Service, PermissionsService],
})
export class GlobalModule {}
