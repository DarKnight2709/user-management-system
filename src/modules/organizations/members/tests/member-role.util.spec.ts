import { describe, expect, it } from 'vitest';
import {
  localRoleFilter,
  memberLevel,
  memberRoleSelection,
} from '../utils/member-role.util.js';

const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const roles = (...names: string[]) => names.map((name) => ({ role: { name } }));

describe('memberLevel', () => {
  it('gives roleless members the MEMBER level', () => {
    expect(memberLevel([])).toBe(memberLevel(roles('MEMBER')));
  });

  it('ranks MEMBER < custom roles < ADMIN', () => {
    const member = memberLevel(roles('MEMBER'));
    const custom = memberLevel(roles('AUDITOR'));
    const admin = memberLevel(roles('ADMIN'));

    expect(member).toBeLessThan(custom);
    expect(custom).toBeLessThan(admin);
  });

  it('uses the highest level when several roles are assigned', () => {
    expect(memberLevel(roles('MEMBER', 'AUDITOR', 'ADMIN'))).toBe(
      memberLevel(roles('ADMIN')),
    );
    expect(memberLevel(roles('MEMBER', 'AUDITOR'))).toBe(
      memberLevel(roles('AUDITOR')),
    );
  });

  it('treats every non-built-in role name as the same custom level', () => {
    expect(memberLevel(roles('ZETA'))).toBe(memberLevel(roles('ALPHA')));
  });
});

describe('localRoleFilter', () => {
  it('selects active, non-system roles of the organization excluding OWNER', () => {
    expect(localRoleFilter(organizationId)).toEqual({
      organizationId,
      isSystem: false,
      deletedAt: null,
      name: { not: 'OWNER' },
    });
  });
});

describe('memberRoleSelection', () => {
  it('only counts active assignments of local roles', () => {
    expect(memberRoleSelection(organizationId)).toEqual({
      where: { deletedAt: null, role: localRoleFilter(organizationId) },
      select: { role: { select: { name: true } } },
    });
  });
});
