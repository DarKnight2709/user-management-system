import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { currentRequestId } from '@/common/utils/request-id.util.js';
import { assertValidPagination } from '@/common/utils/pagination.util.js';
import type {
  AdminOrganizationStatus,
  ListAdminOrganizationsQueryDto,
} from './dto/list-admin-organizations-query.dto.js';
import type { ManageableOrganizationStatus } from './dto/update-admin-organization-status.dto.js';
import type {
  ListAdminOrganizationsInput,
  StatusChangedAuditInput,
  UpdateOrganizationStatusInput,
} from './interfaces/admin-organizations.interface.js';

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

type AdminOrganization = Prisma.OrganizationGetPayload<{
  select: typeof adminOrganizationSelect;
}>;

const statusFilters: Record<
  AdminOrganizationStatus,
  Prisma.OrganizationWhereInput
> = {
  ACTIVE: { deletedAt: null, isActive: true },
  SUSPENDED: { deletedAt: null, isActive: false },
  DELETED: { deletedAt: { not: null } },
};

const getAdminOrganizationStatus = (organization: {
  isActive: boolean;
  deletedAt: Date | null;
}): AdminOrganizationStatus =>
  organization.deletedAt
    ? 'DELETED'
    : organization.isActive
      ? 'ACTIVE'
      : 'SUSPENDED';

@Injectable()
export class AdminOrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly logging: LoggingService,
  ) {}

  async list(
    actorId: string,
    { page, limit, search, status }: ListAdminOrganizationsQueryDto,
  ) {
    assertValidPagination(page, limit);

    return this.prisma.serializableTransaction((manager) =>
      this.listOrganizationsInTransaction(manager, {
        actorId,
        page,
        limit,
        search,
        status,
      }),
    );
  }

  async updateStatus(
    actorId: string,
    organizationId: string,
    status: ManageableOrganizationStatus,
  ) {
    const result = await this.prisma.serializableTransaction((manager) =>
      this.updateOrganizationStatusInTransaction(manager, {
        actorId,
        organizationId,
        status,
      }),
    );

    if (result.auditEvent)
      this.logging.publishCommittedAudit(result.auditEvent);

    return this.mapAdminOrganization(result.organization);
  }

  private buildOrganizationListFilter(
    search: string | undefined,
    status: AdminOrganizationStatus | undefined,
  ): Prisma.OrganizationWhereInput {
    return {
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(status ? statusFilters[status] : {}),
    };
  }

  private async listOrganizationsInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, page, limit, search, status }: ListAdminOrganizationsInput,
  ) {
    await this.authorize(actorId, 'read', manager);

    const where = this.buildOrganizationListFilter(search, status);
    const { organizations, total } = await this.findOrganizationPage(
      manager,
      { where, page, limit },
    );

    return {
      items: organizations.map((organization) =>
        this.mapAdminOrganization(organization),
      ),
      total,
      page,
      limit,
    };
  }

  private async updateOrganizationStatusInTransaction(
    manager: Prisma.TransactionClient,
    { actorId, organizationId, status }: UpdateOrganizationStatusInput,
  ) {
    await this.authorize(actorId, 'update', manager);

    const organization = await this.findOrganizationForStatusUpdate(
      manager,
      organizationId,
    );
    const previousStatus = this.getStatus(organization);
    if (previousStatus === status) {
      return { organization, auditEvent: null };
    }

    const updatedOrganization = await this.updateOrganizationStatus(
      manager,
      organizationId,
      status,
    );
    const auditEvent = await this.createStatusChangedAudit(manager, {
      actorId,
      organizationId,
      previousStatus,
      status,
    });

    return { organization: updatedOrganization, auditEvent };
  }

  private async findOrganizationForStatusUpdate(
    manager: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<AdminOrganization> {
    const organization = await manager.organization.findUnique({
      where: { id: organizationId },
      select: adminOrganizationSelect,
    });
    if (!organization) throw new NotFoundException('Organization not found');
    if (organization.deletedAt) {
      throw new ConflictException(
        'A deleted organization cannot be reactivated with this operation',
      );
    }
    return organization;
  }

  private getStatus(
    organization: AdminOrganization,
  ): ManageableOrganizationStatus {
    return organization.isActive ? 'ACTIVE' : 'SUSPENDED';
  }

  private updateOrganizationStatus(
    manager: Prisma.TransactionClient,
    organizationId: string,
    status: ManageableOrganizationStatus,
  ): Promise<AdminOrganization> {
    return manager.organization.update({
      where: { id: organizationId, deletedAt: null },
      data: { isActive: status === 'ACTIVE' },
      select: adminOrganizationSelect,
    });
  }

  private createStatusChangedAudit(
    manager: Prisma.TransactionClient,
    {
      actorId,
      organizationId,
      previousStatus,
      status,
    }: StatusChangedAuditInput,
  ) {
    return this.logging.audit(
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
  }

  private async findOrganizationPage(
    manager: Prisma.TransactionClient,
    input: {
      where: Prisma.OrganizationWhereInput;
      page: number;
      limit: number;
    },
  ) {
    const { where, page, limit } = input;
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

    return { organizations, total };
  }

  private mapAdminOrganization(
    organization: Prisma.OrganizationGetPayload<{
      select: typeof adminOrganizationSelect;
    }>,
  ) {
    return {
      ...organization,
      status: getAdminOrganizationStatus(organization),
    };
  }

  private async authorize(
    actorId: string,
    action: 'read' | 'update',
    manager: Prisma.TransactionClient,
  ) {
    await this.permissions.assertActiveActor(actorId, manager);

    const allowed = await this.permissions.hasPlatformPermission(
      actorId,
      { resource: 'ORGANIZATION', action },
      manager,
    );
    if (!allowed) throw new ForbiddenException('Access denied');
  }
}
