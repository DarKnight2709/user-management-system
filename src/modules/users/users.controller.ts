import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { UsersService } from './users.service.js';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  // get all users
  @Get()
  async findAll(): Promise<User[]> {
    return this.usersService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<User> {
    return this.usersService.findOne(id);
  }

  // create
  @Post()
  async create(@Body() dto: UserDto): Promise<User> {
    return this.usersService.create(dto);
  }

  // update
  @Put(':id')
  async update(@Param('id') id: string, @Body() dto: UserDto): Promise<User> {
    return this.usersService.update(id, dto);
  }

  // delete
  @Delete(':id')
  async delete(@Param('id') id: string): Promise<void> {
    return this.usersService.delete(id);
  }
}
