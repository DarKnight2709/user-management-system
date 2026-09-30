import { Injectable, NotFoundException } from '@nestjs/common';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';

@Injectable()
export class UsersService {
  constructor(private readonly prismaService: PrismaService) {}

  async findAll(): Promise<User[]> {
    return this.prismaService.user.findMany();
  }

  async findOne(id: string): Promise<User> {
    const existingUser = await this.prismaService.user.findUnique({
      where: { id },
    });

    if (!existingUser) {
      throw new NotFoundException('User not Found');
    }

    return existingUser;
  }

  async create(user: UserDto): Promise<User> {
    const newUser = await this.prismaService.user.create({
      data: user,
    });
    return newUser;
  }

  async update(id: string, updateUserDto: UserDto): Promise<User> {
    const updatedUser = await this.prismaService.user.update({
      where: { id },
      data: updateUserDto,
    });
    return updatedUser;
  }

  async delete(id: string): Promise<void> {
    await this.prismaService.user.delete({ where: { id } });
  }
}
