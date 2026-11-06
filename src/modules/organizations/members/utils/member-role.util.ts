import type { Prisma } from '@/generated/prisma/client.js';
import {
  ADMIN_ROLE_NAME,
  MEMBER_ROLE_NAME,
} from '../../constants/organization.constant.js';
import { OWNER_ROLE_NAME } from '../../roles/constants/organization-role.constant.js';

// Hierarchy for removal; ownership is checked separately through ownerId.
const MEMBER_LEVEL = 0;
const CUSTOM_ROLE_LEVEL = 1;
const ADMIN_LEVEL = 2;

const roleLevelOf = (roleName: string): number => {
  if (roleName === ADMIN_ROLE_NAME) return ADMIN_LEVEL;
  if (roleName === MEMBER_ROLE_NAME) return MEMBER_LEVEL;
  return CUSTOM_ROLE_LEVEL;
};

/** Active, same-organization, non-system roles; legacy OWNER roles never count. */
export const localRoleFilter = (organizationId: string) =>
  ({
    organizationId,
    isSystem: false,
    deletedAt: null,
    name: { not: OWNER_ROLE_NAME },
  }) satisfies Prisma.RoleWhereInput;

/** Active role assignments that count towards a member's hierarchy level. */
export const memberRoleSelection = (organizationId: string) =>
  ({
    where: { deletedAt: null, role: localRoleFilter(organizationId) },
    select: { role: { select: { name: true } } },
  }) as const;

/** Highest level among the assignments; roleless members have MEMBER level. */
export const memberLevel = (
  assignments: { role: { name: string } }[],
): number =>
  Math.max(
    MEMBER_LEVEL,
    ...assignments.map(({ role }) => roleLevelOf(role.name)),
  );
