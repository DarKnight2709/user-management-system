import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { User } from './interfaces/user.interface.js';
import { UserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { hash } from '@/common/utils/hash.util.js';
import { randomUUID } from 'crypto';
import { S3Service } from '@/core/storage/s3.service.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

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
  ): Promise<{ key: string }> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }
    await this.findOne(userId);

    const key = `avatars/${userId}-${randomUUID()}.jpg`;
    await this.s3Service.upload(key, file.buffer, 'image/jpeg');

    try {
      await this.prismaService.user.update({
        where: { id: userId },
        data: { avatarKey: key },
      });
      return { key };
    } catch (databaseError) {
      try {
        await this.s3Service.delete(key);
        this.logger.warn(`Roll back object: ${key}`);
      } catch (deleteError) {
        this.logger.error('Failed to delete key', deleteError);
      }
      throw databaseError;
    }
  }
}
