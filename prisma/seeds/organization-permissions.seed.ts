import type { PrismaClient } from '../../src/generated/prisma/client.js';

const organizationPermissions = [
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
    resource: 'ORGANIZATION',
    action: 'delete',
    description: 'Delete organizations within the authorized scope',
  },
  {
    resource: 'ORGANIZATION',
    action: 'transfer-ownership',
    description: 'Transfer organization ownership',
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
] as const;

export async function seedOrganizationPermissions(
  prisma: PrismaClient,
): Promise<void> {
  await prisma.$transaction(async (manager) => {
    for (const permission of organizationPermissions) {
      await manager.permission.upsert({
        where: {
          action_resource: {
            action: permission.action,
            resource: permission.resource,
          },
        },
        create: permission,
        // Preserve deliberate permission revocation on reruns.
        update: { description: permission.description },
      });
    }
  });
  console.log(
    'Organization permission catalog seeded. No roles or assignments changed.',
  );
}
