import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { User, type PaginatedUsers } from './interfaces/user.interface.js';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { randomUUID } from 'crypto';
import { S3Service } from '@/core/storage/s3.service.js';
import type { UserModel } from '@/generated/prisma/models/User.js';
import { AvatarCleanupService } from './avatar-cleanup.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
    private readonly avatarCleanup: AvatarCleanupService,
    private readonly permissionsService: PermissionsService,
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

  async findAllForActor({
    actorId,
    page = 1,
    limit = 20,
  }: {
    actorId: string;
    page?: number;
    limit?: number;
  }): Promise<PaginatedUsers> {
    // Keep pagination bounded even when called without the controller validation pipe.
    assertValidPagination(page, limit);
    const { users, total } = await this.prismaService.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');
        const allowed = await this.permissionsService.hasPlatformPermission(
          actorId,
          { resource: 'USER', action: 'read' },
          manager,
        );
        if (!allowed) throw new ForbiddenException('Access denied');

        // Count and page use the same snapshot; the ID breaks creation-time ties.
        const [users, total] = await Promise.all([
          manager.user.findMany({
            where: { deletedAt: null },
            omit: { hashedPassword: true },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            skip: (page - 1) * limit,
            take: limit,
          }),
          manager.user.count({ where: { deletedAt: null } }),
        ]);
        return { users, total };
      },
    );
    return {
      items: users.map((user) => this.toUserResponse(user)),
      total,
      page,
      limit,
    };
  }

  async findOneByEmail(email: string): Promise<User | null> {
    const user = await this.prismaService.user.findUnique({
      where: { email: email.trim().toLowerCase(), deletedAt: null },
    });
    if (!user) return null;
    return this.toUserResponse(user);
  }

  /** Internal active-user lookup for JWT validation and avatar upload. */
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

  /** Public account reads require self-access or platform USER:read. */
  async findOneForActor({
    actorId,
    targetId,
  }: {
    actorId: string;
    targetId: string;
  }): Promise<User> {
    const user = await this.prismaService.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');

        if (actorId !== targetId) {
          const allowed = await this.permissionsService.hasPlatformPermission(
            actorId,
            { resource: 'USER', action: 'read' },
            manager,
          );
          if (!allowed) throw new ForbiddenException('Access denied');
        }

        // Authorize first: callers without permission must not discover target existence.
        const target = await manager.user.findUnique({
          where: { id: targetId, deletedAt: null },
          omit: { hashedPassword: true },
        });
        if (!target) throw new NotFoundException('User not found');
        return target;
      },
    );
    return this.toUserResponse(user);
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
      data: {
        username: updateUserDto.username.trim().toLowerCase(),
        email: updateUserDto.email.trim().toLowerCase(),
        firstName: updateUserDto.firstName,
        lastName: updateUserDto.lastName,
        birthDate: updateUserDto.birthDate,
      },
      omit: { hashedPassword: true },
    });

    return this.toUserResponse(updatedUser);
  }

  /**
   * Shared self/admin deletion: authorize the actor, protect organization ownership
   * and the SUPER_ADMIN account, then soft-delete and revoke refresh sessions.
   * Memberships, role assignments, and the current avatar are retained.
   */
  async delete({
    actorId,
    targetId,
  }: {
    actorId: string;
    targetId: string;
  }): Promise<void> {
    await this.prismaService.serializableTransaction(async (manager) => {
      // JWT authentication may have happened before this account was deleted.
      const actor = await manager.user.findUnique({
        where: { id: actorId, deletedAt: null },
        select: { id: true },
      });
      if (!actor) throw new UnauthorizedException('Authentication required');

      // Self-deletion needs no admin permission; deleting anyone else requires USER:delete.
      if (actorId !== targetId) {
        const allowed = await this.permissionsService.hasPlatformPermission(
          actorId,
          { resource: 'USER', action: 'delete' },
          manager,
        );
        if (!allowed) throw new ForbiddenException('Delete action not allowed');
      }

      // Authorize before lookup so unauthorized callers cannot probe target existence.
      const target = await manager.user.findUnique({
        where: { id: targetId },
        select: { deletedAt: true },
      });
      if (!target) throw new NotFoundException('User not found');
      // Repeat deletion is a no-op only after authenticating and authorizing the actor.
      if (target.deletedAt !== null) return;

      await this.assertDeletionSafeguards(manager, targetId);

      // Both writes commit together; a revocation failure rolls back account deletion.
      const now = new Date();
      await manager.user.update({
        where: { id: targetId, deletedAt: null },
        data: { deletedAt: now },
      });
      await manager.refreshToken.updateMany({
        where: { userId: targetId, revokedAt: null },
        data: { revokedAt: now },
      });
    });
  }

  private async assertDeletionSafeguards(
    manager: Prisma.TransactionClient,
    userId: string,
  ): Promise<void> {
    // No caller may delete an active SUPER_ADMIN, including that account itself.
    // Protection does not depend on its current permission set or other admin count.
    const superAdminAssignment = await manager.userPlatformRole.findFirst({
      where: {
        userId,
        deletedAt: null,
        role: {
          name: 'SUPER_ADMIN',
          isSystem: true,
          organizationId: null,
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (superAdminAssignment) {
      throw new ConflictException('The SUPER_ADMIN account cannot be deleted');
    }

    const ownedOrganization = await manager.organization.findFirst({
      // Inactive organizations still need an owner; only soft-deleted ones are excluded.
      where: { ownerId: userId, deletedAt: null },
      select: { id: true },
    });
    if (ownedOrganization) {
      throw new ConflictException(
        'Transfer ownership or delete owned organizations before deleting this account',
      );
    }
  }

  async upload(
    userId: string,
    file: Express.Multer.File,
  ): Promise<{ key: string; avatarUrl: string | null }> {
    if (!file) {
      throw new BadRequestException('Avatar file is required');
    }
    await this.findOne(userId);

    const key = `${userId}-${randomUUID()}.jpg`;
    // Persist recovery before touching storage. A crash leaves a retryable task.
    // Keep a grace period because a timed-out upload may still finish in storage.
    await this.prismaService.avatarCleanupTask.create({
      data: { objectKey: key, nextAttemptAt: new Date(Date.now() + 3_600_000) },
    });
    await this.s3Service.upload(key, file.buffer, 'image/jpeg');
    await this.prismaService.serializableTransaction(async (manager) => {
      // read the current avatar key
      const user = await manager.user.findUnique({
        where: {
          id: userId,
          deletedAt: null,
        },
        select: {
          avatarKey: true,
        },
      });
      if (!user) throw new NotFoundException('User not found');
      // update with the new key
      await manager.user.update({
        where: { id: userId, deletedAt: null },
        data: { avatarKey: key },
      });
      if (user.avatarKey) {
        await manager.avatarCleanupTask.upsert({
          where: { objectKey: user.avatarKey },
          create: { objectKey: user.avatarKey },
          update: { nextAttemptAt: new Date() },
        });
      }
      // New object is now owned by the user; cancel its recovery task.
      await manager.avatarCleanupTask.delete({ where: { objectKey: key } });
    });

    void this.avatarCleanup.processDue();

    return {
      key,
      avatarUrl: this.s3Service.getPublicUrl(key),
    };
  }
}
