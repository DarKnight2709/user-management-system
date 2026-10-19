import type { PrismaClient } from '../../src/generated/prisma/client.js';

import { organizationPermissions } from '../../src/common/constants/organization-permissions.constant.js';

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
