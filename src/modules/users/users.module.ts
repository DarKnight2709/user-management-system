import { Module } from '@nestjs/common';
import { UsersService } from './users.service.js';
import { UsersController } from './users.controller.js';
import { PassportModule } from '@nestjs/passport';
import { UserDeletionService } from './user-deletion.service.js';
import { UserAvatarService } from './user-avatar.service.js';
import { AvatarCleanupService } from './avatar-cleanup.service.js';
import { AccountSecurityModule } from '../account-security/account-security.module.js';

@Module({
  imports: [PassportModule, AccountSecurityModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserDeletionService,
    UserAvatarService,
    AvatarCleanupService,
  ],
  exports: [UsersService],
})
export class UsersModule {}
