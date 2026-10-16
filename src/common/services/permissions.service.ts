import { Injectable } from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import type { PlatformPermission } from '../decorators/require-platform-permissions.decorator.js';
import type { Prisma } from '@/generated/prisma/client.js';

@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  hasPlatformPermission(
    userId: string,
    permission: PlatformPermission,
    manager?: Prisma.TransactionClient,
  ): Promise<boolean> {
    return this.hasPlatformPermissions(userId, [permission], manager);
  }

  async hasPlatformPermissions(
    userId: string,
    required: PlatformPermission[],
    manager: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    if (!userId.trim() || required.length === 0) return false;

    const assignments = await manager.userPlatformRole.findMany({
      where: {
        userId,
        deletedAt: null,
        user: { deletedAt: null },
        role: {
          isSystem: true,
          organizationId: null,
          deletedAt: null,
        },
      },
      select: {
        role: {
          select: {
            rolePermissions: {
              where: {
                deletedAt: null,
                permission: { deletedAt: null, OR: required },
              },
              select: {
                permission: { select: { action: true, resource: true } },
              },
            },
          },
        },
      },
    });

    const grantedPermissions = assignments.flatMap(({ role }) =>
      role.rolePermissions.map(({ permission }) => permission),
    );

    return required.every((needed) =>
      grantedPermissions.some(
        (granted) =>
          granted.resource === needed.resource &&
          granted.action === needed.action,
      ),
    );
  }
}
