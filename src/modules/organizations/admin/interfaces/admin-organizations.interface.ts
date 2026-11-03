import type { AdminOrganizationStatus } from '../dto/list-admin-organizations-query.dto.js';
import type { ManageableOrganizationStatus } from '../dto/update-admin-organization-status.dto.js';

export interface ListAdminOrganizationsInput {
  actorId: string;
  page: number;
  limit: number;
  search?: string;
  status?: AdminOrganizationStatus;
}

export interface UpdateOrganizationStatusInput {
  actorId: string;
  organizationId: string;
  status: ManageableOrganizationStatus;
}

export interface StatusChangedAuditInput {
  actorId: string;
  organizationId: string;
  previousStatus: ManageableOrganizationStatus;
  status: ManageableOrganizationStatus;
}
