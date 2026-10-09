import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { User } from './interfaces/user.interface.js';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { randomUUID } from 'crypto';
import { S3Service } from '@/core/storage/s3.service.js';
import type { UserModel } from '@/generated/prisma/models/User.js';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
  ) {}

  private toUserResponse(
    user:
      | UserModel
      | (Omit<UserModel, 'hashedPassword'> & { hashedPassword?: string }),
  ): User {
    const { avatarKey, ...rest } = user;
    return {
      ...rest,
      avatarUrl: this.s3Service.getPublicUrl(avatarKey),
    };
  }

  async findAll(): Promise<User[]> {
    const users = await this.prismaService.user.findMany({
      where: { deletedAt: null },
      omit: { hashedPassword: true },
    });

    return users.map((user) => this.toUserResponse(user));
  }

  async findOneByEmail(email: string): Promise<User | null> {
    const user = await this.prismaService.user.findUnique({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
    });
    if (!user) return null;
    return this.toUserResponse(user);
  }

  async findOne(id: string): Promise<User> {
    const existingUser = await this.prismaService.user.findUnique({
      where: { id, deletedAt: null },
      omit: { hashedPassword: true },
    });

    if (!existingUser) {
      throw new NotFoundException('User not Found');
    }

    return this.toUserResponse(existingUser);
  }

  async create(user: CreateUserDto): Promise<User> {
    const newUser = await this.prismaService.user.create({
      data: Object.assign({}, user, {
        email: user.email.trim().toLowerCase(),
        username: user.username.trim().toLowerCase(),
      }),
      omit: {
        hashedPassword: true,
      },
    });

    return this.toUserResponse(newUser);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const updatedUser = await this.prismaService.user.update({
      where: { id, deletedAt: null },
      data: Object.assign({}, updateUserDto, {
        email: updateUserDto.email.trim().toLowerCase(),
        username: updateUserDto.username.trim().toLowerCase(),
      }),
      omit: { hashedPassword: true },
    });

    return this.toUserResponse(updatedUser);
  }

  async delete(id: string): Promise<void> {
    await this.prismaService.serializableTransaction(async (manager) => {
      const now = new Date();
      await manager.user.update({
        where: { id, deletedAt: null },
        data: { deletedAt: now },
      });
      await manager.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }

  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ key: string; avatarUrl: string | null }> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }
    await this.findOne(userId);

    const key = `avatars/${userId}-${randomUUID()}.jpg`;
    await this.s3Service.upload(key, file.buffer, 'image/jpeg');

    try {
      await this.prismaService.user.update({
        where: { id: userId, deletedAt: null },
        data: { avatarKey: key },
      });
      return {
        key,
        avatarUrl: this.s3Service.getPublicUrl(key),
      };
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
