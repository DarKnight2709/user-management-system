import { SetMetadata } from '@nestjs/common';

export const ORGANIZATION_PERMISSIONS_KEY = 'requiredOrganizationPermissions';

export interface OrganizationPermission {
  resource: string;
  action: string;
}

export interface OrganizationPermissionRequirement {
  permissions: OrganizationPermission[];
  organizationIdParam: string;
}

export const RequireOrganizationPermissions = (
  ...permissions: OrganizationPermission[]
) =>
  SetMetadata(ORGANIZATION_PERMISSIONS_KEY, {
    permissions,
    organizationIdParam: 'organizationId',
  } satisfies OrganizationPermissionRequirement);
