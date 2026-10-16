import {
  ConflictException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { PermissionsService } from '@/common/services/permissions.service.js';

const adminPermissions = [
  { resource: 'ORGANIZATION', action: 'read' },
  { resource: 'ORGANIZATION', action: 'update' },
  { resource: 'ORGANIZATION_MEMBER', action: 'read' },
  { resource: 'ORGANIZATION_MEMBER', action: 'invite' },
  { resource: 'ORGANIZATION_MEMBER', action: 'remove' },
  { resource: 'ORGANIZATION_ROLE', action: 'read' },
];

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async findOneForActor(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction(async (manager) => {
      const actor = await manager.user.findUnique({
        where: { id: actorId, deletedAt: null },
        select: { id: true },
      });
      if (!actor) throw new UnauthorizedException('Authentication required');
      const allowed = await this.permissionsService.hasOrganizationPermissions(
        actorId,
        organizationId,
        [{ resource: 'ORGANIZATION', action: 'read' }],
        manager,
      );
      // Missing and inaccessible organizations have the same response.
      if (!allowed) throw new ForbiddenException('Organization access denied');
      return manager.organization.findUniqueOrThrow({
        where: { id: organizationId, deletedAt: null, isActive: true },
        select: {
          id: true,
          name: true,
          slug: true,
          ownerId: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });
  }

  async create(actorId: string, dto: CreateOrganizationDto) {
    return this.prisma.serializableTransaction(async (manager) => {
      const actor = await manager.user.findUnique({
        where: { id: actorId, deletedAt: null },
        select: { id: true },
      });
      if (!actor) throw new UnauthorizedException('Authentication required');

      const existing = await manager.organization.findUnique({
        where: { slug: dto.slug },
        select: { id: true },
      });
      if (existing)
        throw new ConflictException('Organization slug is already taken');

      const permissions = await manager.permission.findMany({
        where: { deletedAt: null, OR: adminPermissions },
        select: { id: true, resource: true, action: true },
      });
      if (permissions.length !== adminPermissions.length) {
        // Never create partially configured roles or silently restore revoked permissions.
        throw new ServiceUnavailableException(
          'Organization permissions are not configured',
        );
      }

      const organization = await manager.organization.create({
        data: { name: dto.name, slug: dto.slug, ownerId: actorId },
      });
      await manager.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: actorId,
          status: 'ACTIVE',
        },
      });
      for (const name of ['ADMIN', 'MEMBER']) {
        await manager.role.create({
          data: {
            name,
            organizationId: organization.id,
            isSystem: false,
            rolePermissions: {
              create: permissions
                .filter(
                  (permission) =>
                    name === 'ADMIN' || permission.action === 'read',
                )
                .map((permission) => ({ permissionId: permission.id })),
            },
          },
        });
      }
      // Ownership comes from ownerId and active membership, not an OWNER role.
      return organization;
    });
  }
}
