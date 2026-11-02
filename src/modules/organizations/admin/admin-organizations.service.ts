import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { requestContext } from '@/core/logging/request-context.js';
import { randomUUID } from 'node:crypto';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import type {
  AdminOrganizationStatus,
  ListAdminOrganizationsQueryDto,
} from './dto/list-admin-organizations-query.dto.js';
import type { ManageableOrganizationStatus } from './dto/update-admin-organization-status.dto.js';

const adminOrganizationSelect = {
  id: true,
  name: true,
  slug: true,
  ownerId: true,
  isActive: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
  owner: {
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
    },
  },
} satisfies Prisma.OrganizationSelect;

const getStatus = (organization: {
  isActive: boolean;
  deletedAt: Date | null;
}): AdminOrganizationStatus =>
  organization.deletedAt
    ? 'DELETED'
    : organization.isActive
      ? 'ACTIVE'
      : 'SUSPENDED';

const currentRequestId = () =>
  requestContext.getStore()?.requestId ?? randomUUID();

@Injectable()
export class AdminOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async listForPlatformActor(
    actorId: string,
    { page, limit, search, status }: ListAdminOrganizationsQueryDto,
  ) {
    assertValidPagination(page, limit);

    return this.prisma.serializableTransaction(async (manager) => {
      await this.authorize(actorId, 'read', manager);

      const where: Prisma.OrganizationWhereInput = {
        ...(search
          ? {
              OR: [
                { name: { contains: search, mode: 'insensitive' } },
                { slug: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(status === 'ACTIVE'
          ? { deletedAt: null, isActive: true }
          : status === 'SUSPENDED'
            ? { deletedAt: null, isActive: false }
            : status === 'DELETED'
              ? { deletedAt: { not: null } }
              : {}),
      };

      const [organizations, total] = await Promise.all([
        manager.organization.findMany({
          where,
          select: adminOrganizationSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip: (page - 1) * limit,
          take: limit,
        }),
        manager.organization.count({ where }),
      ]);

      return {
        items: organizations.map((organization) => ({
          ...organization,
          status: getStatus(organization),
        })),
        total,
        page,
        limit,
      };
    });
  }

  async updateStatusForPlatformActor(
    actorId: string,
    organizationId: string,
    status: ManageableOrganizationStatus,
  ) {
    const result = await this.prisma.serializableTransaction(
      async (manager) => {
        await this.authorize(actorId, 'update', manager);

        const current = await manager.organization.findUnique({
          where: { id: organizationId },
          select: {
            id: true,
            name: true,
            slug: true,
            ownerId: true,
            isActive: true,
            deletedAt: true,
            createdAt: true,
            updatedAt: true,
            owner: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        });
        if (!current) throw new NotFoundException('Organization not found');
        if (current.deletedAt) {
          throw new ConflictException(
            'A deleted organization cannot be reactivated with this operation',
          );
        }

        const previousStatus: ManageableOrganizationStatus = current.isActive
          ? 'ACTIVE'
          : 'SUSPENDED';
        if (previousStatus === status) {
          return { organization: current, auditEvent: null };
        }

        const updated = await manager.organization.update({
          where: { id: organizationId, deletedAt: null },
          data: { isActive: status === 'ACTIVE' },
          select: adminOrganizationSelect,
        });
        const auditEvent = await this.logging.audit(
          {
            action: 'organization.status.changed',
            actor: { type: 'USER', id: actorId },
            target: { type: 'ORGANIZATION', id: organizationId },
            organizationId,
            payload: { before: previousStatus, after: status },
            requestContext: { requestId: currentRequestId() },
          },
          manager,
        );

        return { organization: updated, auditEvent };
      },
    );

    if (result.auditEvent)
      this.logging.publishCommittedAudit(result.auditEvent);

    return { ...result.organization, status: getStatus(result.organization) };
  }

  private async authorize(
    actorId: string,
    action: 'read' | 'update',
    manager: Prisma.TransactionClient,
  ) {
    const actor = await manager.user.findUnique({
      where: { id: actorId, deletedAt: null },
      select: { id: true },
    });
    if (!actor) throw new UnauthorizedException('Authentication required');

    const allowed = await this.permissions.hasPlatformPermission(
      actorId,
      { resource: 'ORGANIZATION', action },
      manager,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
  }
}
