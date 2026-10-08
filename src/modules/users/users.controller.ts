import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseFilePipe,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UsersService } from './users.service.js';
import { User } from './interfaces/user.interface.js';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard.js';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { AvatarUploadInterceptor } from '@/common/interceptors/avatar-upload.interceptor.js';
import { IsJpegValidator } from '@/common/validators/is-jpeg.validator.js';
import { UpdateUserDto } from './dto/user.dto.js';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // get all users
  // only admin
  @UseGuards(JwtAuthGuard)
  @Get()
  @ApiOperation({ summary: 'Get all users' })
  async findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  // self or admin
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  @ApiOperation({ summary: 'Get user by ID' })
  async findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') currentUserId: string,
  ): Promise<User> {
    if (id !== currentUserId) {
      throw new ForbiddenException('Access denied');
    }
    return this.usersService.findOne(id);
  }

  // update
  @UseGuards(JwtAuthGuard)
  @Put()
  @ApiOperation({ summary: 'Update user by ID' })
  async update(
    @Body() dto: UpdateUserDto,
    @CurrentUser('id') currentUserId: string,
  ): Promise<User> {
    return this.usersService.update(currentUserId, dto);
  }

  // delete
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @ApiOperation({ summary: 'Delete user by ID' })
  @HttpCode(HttpStatus.NO_CONTENT) // Returns 204 No Content
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('id') currentUserId: string,
  ): Promise<void> {
    // or admin
    if (id !== currentUserId) {
      throw new ForbiddenException('Delete a ction not allowed');
    }
    return this.usersService.delete(currentUserId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('avatar')
  @ApiOperation({ summary: 'Upload user avatar (JPEG)' })
  @UseInterceptors(AvatarUploadInterceptor)
  async upload(
    @CurrentUser('id') userId: string,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new IsJpegValidator()],
        errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
        fileIsRequired: true,
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.usersService.upload(userId, file);
  }
}
