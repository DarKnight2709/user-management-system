import { Global, Module } from '@nestjs/common';
import { PrismaService } from '../../core/database/prisma.service.js';
import { S3Service } from '../../core/storage/s3.service.js';

@Global()
@Module({
  providers: [PrismaService, S3Service],
  exports: [PrismaService, S3Service],
})
export class GlobalModule {}
