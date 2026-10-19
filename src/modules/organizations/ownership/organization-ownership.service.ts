import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';

@Injectable()
export class OrganizationOwnershipService {
  constructor(private readonly prisma: PrismaService) {}

  async transferForActor(
    actorId: string,
    organizationId: string,
    memberId: string,
  ) {
    return this.prisma.serializableTransaction(async (manager) => {
      const ownerMembership = await this.authorizeOwner(
        manager,
        actorId,
        organizationId,
      );
      const target = await manager.organizationMember.findFirst({
        where: {
          id: memberId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
          user: { deletedAt: null },
        },
        select: { userId: true },
      });
      if (!target)
        throw new NotFoundException('Active organization member not found');
      if (target.userId === actorId)
        throw new ConflictException(
          'Choose a different member as the new owner',
        );

      await this.ensureMemberRole(manager, organizationId, ownerMembership.id);
      const organization = await manager.organization.update({
        where: {
          id: organizationId,
          ownerId: actorId,
          isActive: true,
          deletedAt: null,
        },
        data: { ownerId: target.userId },
        select: { id: true, ownerId: true },
      });
      return { ...organization, previousOwnerId: actorId };
    });
  }

  private async authorizeOwner(
    manager: Prisma.TransactionClient,
    actorId: string,
    organizationId: string,
  ) {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');
    const membership = await manager.organizationMember.findFirst({
      where: {
        userId: actorId,
        organizationId,
        status: 'ACTIVE',
        deletedAt: null,
        user: { deletedAt: null },
        organization: { ownerId: actorId, isActive: true, deletedAt: null },
      },
      select: { id: true },
    });
    if (!membership)
      throw new ForbiddenException(
        'Only the active organization owner can transfer ownership',
      );
    return membership;
  }

  private async ensureMemberRole(
    manager: Prisma.TransactionClient,
    organizationId: string,
    memberId: string,
  ): Promise<void> {
    const role = await manager.role.findFirst({
      where: {
        organizationId,
        name: 'MEMBER',
        isSystem: false,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!role)
      throw new ServiceUnavailableException(
        'Organization MEMBER role is unavailable',
      );
    const where = {
      organizationMemberId_roleId: {
        organizationMemberId: memberId,
        roleId: role.id,
      },
    };
    const existing = await manager.memberRole.findUnique({
      where,
      select: { deletedAt: true },
    });
    if (existing && existing.deletedAt === null) return;
    await manager.memberRole.upsert({
      where,
      create: { organizationMemberId: memberId, roleId: role.id },
      update: { deletedAt: null },
    });
  }
}
