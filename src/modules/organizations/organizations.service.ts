import { assertValidPagination } from '@/common/utils/pagination.util.js';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '@/core/database/prisma.service.js';
import { CreateOrganizationDto } from './dto/create-organization.dto.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { UpdateOrganizationDto } from './dto/update-organization.dto.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';
import { randomUUID } from 'node:crypto';

const currentRequestId = () =>
  requestContext.getStore()?.requestId ?? randomUUID();

const organizationDetails = {
  id: true,
  name: true,
  slug: true,
  ownerId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

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
    private readonly logging: LoggingService,
  ) {}

  async deleteForActor(actorId: string, organizationId: string): Promise<void> {
    const auditEvent = await this.prisma.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');

        const platformAllowed =
          await this.permissionsService.hasPlatformPermission(
            actorId,
            { resource: 'ORGANIZATION', action: 'delete' },
            manager,
          );
        const organization = await manager.organization.findUnique({
          where: { id: organizationId },
          select: {
            ownerId: true,
            deletedAt: true,
            name: true,
            slug: true,
          },
        });
        if (!organization) {
          if (platformAllowed)
            throw new NotFoundException('Organization not found');
          throw new ForbiddenException('Organization deletion access denied');
        }

        if (!platformAllowed) {
          const ownerMembership =
            organization.ownerId === actorId
              ? await manager.organizationMember.findFirst({
                  where: {
                    organizationId,
                    userId: actorId,
                    status: 'ACTIVE',
                    deletedAt: null,
                  },
                  select: { id: true },
                })
              : null;
          if (!ownerMembership)
            throw new ForbiddenException('Organization deletion access denied');
        }
        if (organization.deletedAt) return null;

        const now = new Date();
        await manager.organization.update({
          where: { id: organizationId, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        const revokedInvitations =
          await manager.organizationInvitation.updateMany({
            where: { organizationId, status: 'PENDING' },
            data: { status: 'REVOKED', revokedAt: now },
          });

        return this.logging.audit(
          {
            action: 'organization.deleted',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION', id: organizationId },
            organizationId,
            payload: {
              name: organization.name,
              slug: organization.slug,
              ownerId: organization.ownerId,
              revokedPendingInvitationCount: revokedInvitations.count,
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
      },
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
  }

  async currentPermissions(actorId: string, organizationId: string) {
    return this.prisma.serializableTransaction((manager) =>
      this.permissionsService.getEffectiveOrganizationPermissions(
        actorId,
        organizationId,
        manager,
      ),
    );
  }

  async updateForActor(
    actorId: string,
    organizationId: string,
    dto: UpdateOrganizationDto,
  ) {
    const { result, auditEvent } = await this.prisma.serializableTransaction(
      async (manager) => {
        const actor = await manager.user.findUnique({
          where: { id: actorId, deletedAt: null },
          select: { id: true },
        });
        if (!actor) throw new UnauthorizedException('Authentication required');
        const allowed =
          await this.permissionsService.hasOrganizationPermissions(
            actorId,
            organizationId,
            [{ resource: 'ORGANIZATION', action: 'update' }],
            manager,
          );
        if (!allowed)
          throw new ForbiddenException('Organization access denied');
        const current = await manager.organization.findUniqueOrThrow({
          where: { id: organizationId, deletedAt: null, isActive: true },
          select: organizationDetails,
        });
        if (current.name === dto.name) {
          return { result: current, auditEvent: null };
        }
        const updated = await manager.organization.update({
          where: { id: organizationId, deletedAt: null, isActive: true },
          // Explicit allowlist also protects direct service calls from mass assignment.
          data: { name: dto.name },
          select: organizationDetails,
        });
        const auditEvent = await this.logging.audit(
          {
            action: 'organization.updated',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION', id: organizationId },
            organizationId,
            payload: {
              before: { name: current.name },
              after: { name: updated.name },
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return { result: updated, auditEvent };
      },
    );
    if (auditEvent) this.logging.publishCommittedAudit(auditEvent);
    return result;
  }

  async findAllForActor({
    actorId,
    page = 1,
    limit = 20,
  }: {
    actorId: string;
    page?: number;
    limit?: number;
  }) {
    assertValidPagination(page, limit);
    return this.prisma.serializableTransaction(async (manager) => {
      const actor = await manager.user.findUnique({
        where: { id: actorId, deletedAt: null },
        select: { id: true },
      });
      if (!actor) throw new UnauthorizedException('Authentication required');
      const ids = await this.permissionsService.findAuthorizedOrganizationIds(
        actorId,
        [{ resource: 'ORGANIZATION', action: 'read' }],
        manager,
      );
      const where = { id: { in: ids }, deletedAt: null, isActive: true };
      const [items, total] = await Promise.all([
        manager.organization.findMany({
          where,
          select: organizationDetails,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        manager.organization.count({ where }),
      ]);
      return { items, total, page, limit };
    });
  }

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
        select: organizationDetails,
      });
    });
  }

  async create(actorId: string, dto: CreateOrganizationDto) {
    const { organization, auditEvent } =
      await this.prisma.serializableTransaction(async (manager) => {
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
        const auditEvent = await this.logging.audit(
          {
            action: 'organization.created',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION', id: organization.id },
            organizationId: organization.id,
            payload: {
              name: organization.name,
              slug: organization.slug,
              ownerId: organization.ownerId,
            },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );
        return { organization, auditEvent };
      });
    this.logging.publishCommittedAudit(auditEvent);
    return organization;
  }
}
