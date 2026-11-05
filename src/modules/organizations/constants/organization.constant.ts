import type { Prisma } from '@/generated/prisma/client.js';

export const organizationDetailsSelect = {
  id: true,
  name: true,
  slug: true,
  ownerId: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect;

export const ADMIN_ROLE_NAME = 'ADMIN';
export const MEMBER_ROLE_NAME = 'MEMBER';

/** Catalog entries a new organization's ADMIN role receives. */
export const defaultAdminPermissions = [
  { resource: 'ORGANIZATION', action: 'read' },
  { resource: 'ORGANIZATION', action: 'update' },
  { resource: 'ORGANIZATION_MEMBER', action: 'read' },
  { resource: 'ORGANIZATION_MEMBER', action: 'invite' },
  { resource: 'ORGANIZATION_MEMBER', action: 'remove' },
  { resource: 'ORGANIZATION_ROLE', action: 'read' },
  { resource: 'ORGANIZATION_AUDIT_LOG', action: 'read' },
] as const;

/** MEMBER may read, except for the organization audit history. */
export const isDefaultMemberPermission = ({
  resource,
  action,
}: {
  resource: string;
  action: string;
}): boolean => action === 'read' && resource !== 'ORGANIZATION_AUDIT_LOG';
