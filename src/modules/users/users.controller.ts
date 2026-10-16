import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { User, type PaginatedUsers } from './interfaces/user.interface.js';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { AvatarUploadInterceptor } from '@/common/interceptors/avatar-upload.interceptor.js';
import { JpegAvatarPipe } from '@/common/pipes/jpeg-avatar.pipe.js';
import { UpdateUserDto } from './dto/user.dto.js';
import { RequirePlatformPermissions } from '@/common/decorators/require-platform-permissions.decorator.js';
import { ListUsersQueryDto } from './dto/list-users-query.dto.js';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // Listing always requires platform USER:read, including for SUPER_ADMIN.
  @Get()
  @RequirePlatformPermissions({ resource: 'USER', action: 'read' })
  @ApiOperation({ summary: 'List active users with pagination' })
  async findAll(
    @Query() query: ListUsersQueryDto,
    @CurrentUser('id') actorId: string,
  ): Promise<PaginatedUsers> {
    return this.usersService.findAllForActor({
      actorId,
      page: query.page,
      limit: query.limit,
    });
  }

  // self or admin
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') currentUserId: string,
  ): Promise<User> {
    return this.usersService.findOneForActor({
      actorId: currentUserId,
      targetId: id,
    });
  }

  // update
  @Put()
  @ApiOperation({ summary: 'Update user by ID' })
  async update(
    @Body() dto: UpdateUserDto,
    @CurrentUser('id') currentUserId: string,
  ): Promise<User> {
    return this.usersService.update(currentUserId, dto);
  }

  // delete
  @Delete(':id')
  @ApiOperation({ summary: 'Delete user by ID' })
  @HttpCode(HttpStatus.NO_CONTENT) // Returns 204 No Content
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') currentUserId: string,
  ): Promise<void> {
    await this.usersService.delete({ actorId: currentUserId, targetId: id });
  }

  @Post('avatar')
  @ApiOperation({ summary: 'Upload user avatar (JPEG)' })
  @UseInterceptors(AvatarUploadInterceptor)
  async upload(
    @CurrentUser('id') userId: string,
    @UploadedFile(new JpegAvatarPipe())
    file: Express.Multer.File,
  ) {
    return this.usersService.upload(userId, file);
  }
}
