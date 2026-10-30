export const organizationAuditPermission = {
  resource: 'ORGANIZATION_AUDIT_LOG',
  action: 'read',
  description: 'View audit history for this organization',
} as const;

export const organizationPermissions = [
  {
    resource: 'ORGANIZATION',
    action: 'read',
    description: 'View organization details',
  },
  {
    resource: 'ORGANIZATION',
    action: 'update',
    description: 'Update organization details',
  },
  {
    resource: 'ORGANIZATION_MEMBER',
    action: 'read',
    description: 'View organization members',
  },
  {
    resource: 'ORGANIZATION_MEMBER',
    action: 'invite',
    description: 'Invite ordinary organization members',
  },
  {
    resource: 'ORGANIZATION_MEMBER',
    action: 'remove',
    description: 'Remove ordinary organization members',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'create',
    description: 'Create organization roles',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'read',
    description: 'View organization roles and their permissions',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'update',
    description: 'Update organization roles and their permissions',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'delete',
    description: 'Delete organization roles',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'assign',
    description: 'Assign organization roles to members',
  },
  {
    resource: 'ORGANIZATION_ROLE',
    action: 'revoke',
    description: 'Revoke organization roles from members',
  },
  organizationAuditPermission,
] as const;
