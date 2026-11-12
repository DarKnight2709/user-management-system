import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { User, type PaginatedUsers } from './interfaces/user.interface.js';
import { CreateUserDto, UpdateUserDto } from './dto/user.dto.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { S3Service } from '@/core/storage/s3.service.js';
import type { UserModel } from '@/generated/prisma/models/User.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { EmailVerificationService } from '@/modules/account-security/services/email-verification.service.js';

@Injectable()
export class UsersService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly s3Service: S3Service,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
    private readonly emailVerification: EmailVerificationService,
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
        await this.permissions.assertActiveActor(actorId, manager);
        const allowed = await this.permissions.hasPlatformPermission(
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
        await this.permissions.assertActiveActor(actorId, manager);

        if (actorId !== targetId) {
          const allowed = await this.permissions.hasPlatformPermission(
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
    const { newUser, auditEvent } =
      await this.prismaService.serializableTransaction(async (manager) => {
        const newUser = await manager.user.create({
          data: {
            firstName: user.firstName,
            lastName: user.lastName,
            birthDate: user.birthDate,
            hashedPassword: user.hashedPassword,
            email: user.email.trim().toLowerCase(),
            username: user.username.trim().toLowerCase(),
          },
          omit: { hashedPassword: true },
        });
        const auditEvent = await this.logging.audit(
          {
            action: 'user.registered',
            actor: { type: 'ANONYMOUS' },
            target: { type: 'USER', id: newUser.id },
            payload: { registrationMethod: 'PASSWORD' },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return { newUser, auditEvent };
      });

    this.logging.publishCommittedAudit(auditEvent);
    return this.toUserResponse(newUser);
  }

  async update(id: string, updateUserDto: UpdateUserDto): Promise<User> {
    const { user, auditEvent, verificationTokenId } =
      await this.prismaService.serializableTransaction(async (manager) => {
        const current = await manager.user.findUnique({
          where: { id, deletedAt: null },
          omit: { hashedPassword: true },
        });
        if (!current) throw new NotFoundException('User not Found');

        const data = {
          username: updateUserDto.username.trim().toLowerCase(),
          email: updateUserDto.email.trim().toLowerCase(),
          firstName: updateUserDto.firstName,
          lastName: updateUserDto.lastName,
          birthDate: updateUserDto.birthDate,
        };
        const changedFields = (
          Object.keys(data) as (keyof typeof data)[]
        ).filter((field) => {
          const previous = current[field];
          const next = data[field];
          return field === 'birthDate'
            ? (previous instanceof Date
                ? previous.getTime()
                : Date.parse(previous)) !==
                (next instanceof Date ? next.getTime() : Date.parse(next))
            : previous !== next;
        });

        if (changedFields.length === 0)
          return { user: current, auditEvent: null, verificationTokenId: null };

        // A new address is unproven: it loses the verified state and gets its own
        // link, which replaces any link sent for the old address.
        const emailChanged = changedFields.includes('email');
        const updated = await manager.user.update({
          where: { id, deletedAt: null },
          data: emailChanged ? { ...data, emailVerifiedAt: null } : data,
          omit: { hashedPassword: true },
        });
        const verification = emailChanged
          ? await this.emailVerification.issueFor(manager, id)
          : null;
        const auditEvent = await this.logging.audit(
          {
            action: 'user.profile.updated',
            actor: { type: 'USER', id },
            target: { type: 'USER', id },
            payload: { changedFields },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );

        return {
          user: updated,
          auditEvent,
          verificationTokenId: verification?.id ?? null,
        };
      });

    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
    if (verificationTokenId) {
      await this.emailVerification.enqueue(verificationTokenId);
    }
    return this.toUserResponse(user);
  }
}
