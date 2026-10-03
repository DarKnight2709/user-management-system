import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { hash } from '@/common/utils/hash.util.js';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';

@Injectable()
export class UsersService {
  constructor(private readonly prismaService: PrismaService) {}

  async findAll(): Promise<User[]> {
    return this.prismaService.user.findMany({
      omit: { hashedPassword: true },
    });
  }

  async findOneByEmail(email: string): Promise<User | null> {
    return this.prismaService.user.findUnique({
      where: { email },
    });
  }

  async findOne(id: string): Promise<User> {
    const existingUser = await this.prismaService.user.findUnique({
      where: { id },
      omit: { hashedPassword: true },
    });

    if (!existingUser) {
      throw new NotFoundException('User not Found');
    }

    return existingUser;
  }

  async create(user: UserDto): Promise<User> {
    const { password, ...rest } = user;
    const hashedPassword = await hash(password);
    const newUser = await this.prismaService.user.create({
      data: {
        ...rest,
        hashedPassword,
      },
      omit: {
        hashedPassword: true,
      },
    });
    return newUser;
  }

  async update(id: string, updateUserDto: UserDto): Promise<User> {
    const { password, ...rest } = updateUserDto;

    const updateData: any = { ...rest };
    if (password) {
      updateData.hashedPassword = await hash(password);
    }

    return this.prismaService.user.update({
      where: { id },
      data: updateData,
      omit: { hashedPassword: true },
    });
  }

  async delete(id: string): Promise<void> {
    await this.prismaService.user.delete({ where: { id } });
  }

  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ fileName: string; url: string }> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }

    const avatarDirectory = join(process.cwd(), 'uploads', 'avatars');

    await mkdir(avatarDirectory, { recursive: true });

    const fileName = `${userId}-${randomUUID()}.jpg`;
    const filePath = join(avatarDirectory, fileName);

    await writeFile(filePath, file.buffer);

    return {
      fileName,
      url: `/static/avatars/${fileName}`,
    };
  }
}
