import { Module } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { PassportModule } from '@nestjs/passport';
import { AvatarCleanupService } from './avatar-cleanup.service.js';

@Module({
  imports: [PassportModule],
  controllers: [UsersController],
  providers: [UsersService, AvatarCleanupService],
  exports: [UsersService],
})
export class UsersModule {}
