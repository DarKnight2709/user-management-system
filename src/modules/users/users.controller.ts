import {
  Body,
  Controller,
  Delete,
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
import { UsersService } from './users.service.js';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard.js';
import { CurrentUser } from '@/common/decorators/current-user.decorator.js';
import { AvatarUploadInterceptor } from '@/common/interceptors/avatar-upload.interceptor.js';
import { IsJpegValidator } from '@/common/validators/is-jpeg.validator.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // get all users
  @UseGuards(JwtAuthGuard)
  @Get()
  async findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  // create
  @UseGuards(JwtAuthGuard)
  @Post()
  async create(@Body() dto: UserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  // update
  @UseGuards(JwtAuthGuard)
  @Put(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UserDto,
  ): Promise<User> {
    return this.usersService.update(id, dto);
  }

  // delete
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT) // Returns 204 No Content
  async delete(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.usersService.delete(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('avatar')
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
