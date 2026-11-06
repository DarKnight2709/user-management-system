import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { OrganizationAuditAccessService } from '../organization-audit-access.service.js';

const actorId = '323e4567-e89b-42d3-a456-426614174000';
const ownerId = '623e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';

const membership = (ownerOfOrganization: string, roles: string[] = []) => ({
  organization: { ownerId: ownerOfOrganization },
  memberRoles: roles.map((name) => ({ role: { name } })),
});

function setup() {
  const manager = {
    organizationMember: {
      findFirst: vi.fn().mockResolvedValue(membership(actorId)),
    },
  };
  const permissions = {
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  return {
    service: new OrganizationAuditAccessService(
      permissions as unknown as PermissionsService,
    ),
    manager,
    permissions,
    tx: manager as unknown as Prisma.TransactionClient,
  };
}

const assertRead = ({ service, tx }: ReturnType<typeof setup>) =>
  service.assertCanRead(tx, actorId, organizationId);

describe('OrganizationAuditAccessService.assertCanRead', () => {
  it('looks up only an active, nondeleted membership in an active organization', async () => {
    const ctx = setup();

    await assertRead(ctx);

    expect(ctx.manager.organizationMember.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: actorId,
          organizationId,
          status: 'ACTIVE',
          deletedAt: null,
          user: { deletedAt: null },
          organization: { deletedAt: null, isActive: true },
        },
      }),
    );
  });

  it('only considers active non-system roles of the same organization', async () => {
    const ctx = setup();

    await assertRead(ctx);

    const select = (
      ctx.manager.organizationMember.findFirst.mock.calls[0][0] as {
        select: { memberRoles: { where: unknown } };
      }
    ).select;
    expect(select.memberRoles.where).toEqual({
      deletedAt: null,
      role: { organizationId, isSystem: false, deletedAt: null },
    });
  });

  it('denies outsiders, suspended and removed members', async () => {
    const ctx = setup();
    ctx.manager.organizationMember.findFirst.mockResolvedValue(null);

    await expect(assertRead(ctx)).rejects.toMatchObject({ status: 403 });
    expect(ctx.permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('allows the owner who holds the audit permission', async () => {
    const ctx = setup();

    await expect(assertRead(ctx)).resolves.toBeUndefined();
    expect(ctx.permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_AUDIT_LOG', action: 'read' }],
      ctx.tx,
    );
  });

  it('allows a built-in ADMIN with the audit permission', async () => {
    const ctx = setup();
    ctx.manager.organizationMember.findFirst.mockResolvedValue(
      membership(ownerId, ['ADMIN']),
    );

    await expect(assertRead(ctx)).resolves.toBeUndefined();
  });

  it('denies a custom role even when it holds the permission', async () => {
    const ctx = setup();
    ctx.manager.organizationMember.findFirst.mockResolvedValue(
      membership(ownerId, ['AUDITOR']),
    );

    await expect(assertRead(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('denies an ADMIN whose audit permission was removed', async () => {
    const ctx = setup();
    ctx.manager.organizationMember.findFirst.mockResolvedValue(
      membership(ownerId, ['ADMIN']),
    );
    ctx.permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(assertRead(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('denies a plain MEMBER', async () => {
    const ctx = setup();
    ctx.manager.organizationMember.findFirst.mockResolvedValue(
      membership(ownerId, ['MEMBER']),
    );

    await expect(assertRead(ctx)).rejects.toMatchObject({ status: 403 });
  });

  it('uses the same message for every denial', async () => {
    const missing = setup();
    missing.manager.organizationMember.findFirst.mockResolvedValue(null);
    const unprivileged = setup();
    unprivileged.manager.organizationMember.findFirst.mockResolvedValue(
      membership(ownerId),
    );

    const first = await assertRead(missing).catch((e: Error) => e.message);
    const second = await assertRead(unprivileged).catch(
      (e: Error) => e.message,
    );

    expect(first).toBe('Organization audit access denied');
    expect(second).toBe(first);
  });

  it('propagates database errors from the permission check', async () => {
    const ctx = setup();
    ctx.permissions.hasOrganizationPermissions.mockRejectedValue(
      new Error('db down'),
    );

    await expect(assertRead(ctx)).rejects.toThrow('db down');
  });
});
