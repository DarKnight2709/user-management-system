import type { PrismaClient } from '../../src/generated/prisma/client.js';

import {
  organizationAuditPermission,
  organizationPermissions,
} from '../../src/common/constants/organization-permissions.constant.js';

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

    const auditPermission = await manager.permission.findUnique({
      where: {
        action_resource: {
          action: organizationAuditPermission.action,
          resource: organizationAuditPermission.resource,
        },
      },
      select: { id: true, deletedAt: true },
    });
    if (!auditPermission || auditPermission.deletedAt) {
      throw new Error('Organization audit permission is unavailable');
    }

    const adminRoles = await manager.role.findMany({
      where: {
        name: 'ADMIN',
        isSystem: false,
        organizationId: { not: null },
        deletedAt: null,
      },
      select: { id: true },
    });
    for (const role of adminRoles) {
      await manager.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId: role.id,
            permissionId: auditPermission.id,
          },
        },
        create: { roleId: role.id, permissionId: auditPermission.id },
        // Preserve an explicit revocation if this seed is rerun.
        update: {},
      });
    }
  });
  console.log(
    'Organization permission catalog seeded; audit-read access granted to existing ADMIN roles.',
  );
}
