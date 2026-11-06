import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@/generated/prisma/client.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import { InvitationRulesService } from '../services/invitation-rules.service.js';

const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const invitationId = '123e4567-e89b-42d3-a456-426614174000';
const actorId = '323e4567-e89b-42d3-a456-426614174000';

const makeLinks = (secret = 'rules-secret-'.repeat(6)) =>
  new InvitationLinksService(
    new ConfigService({
      INVITATION_TOKEN_SECRET: secret,
      FRONTEND_URL: 'http://frontend.invalid',
    }),
  );

function setup() {
  const links = makeLinks();
  const manager = {
    user: { findFirst: vi.fn().mockResolvedValue(null) },
    organizationMember: { findUnique: vi.fn().mockResolvedValue(null) },
    organizationInvitation: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  return {
    rules: new InvitationRulesService(
      permissions as unknown as PermissionsService,
      links,
    ),
    links,
    manager,
    permissions,
    tx: manager as unknown as Prisma.TransactionClient,
  };
}

const invitation = (
  links: InvitationLinksService,
  overrides: Record<string, unknown> = {},
) =>
  ({
    id: invitationId,
    tokenHash: links.hash(links.token(invitationId)),
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(Date.now() - 60_000),
    ...overrides,
  }) as never;

describe('InvitationRulesService.authorizeActor', () => {
  it('rejects inactive actors before checking permissions', async () => {
    const { rules, permissions, tx } = setup();
    permissions.assertActiveActor.mockRejectedValue(
      Object.assign(new Error('Authentication required'), { status: 401 }),
    );

    await expect(
      rules.authorizeActor(tx, actorId, organizationId),
    ).rejects.toMatchObject({ status: 401 });
    expect(permissions.hasOrganizationPermissions).not.toHaveBeenCalled();
  });

  it('requires ORGANIZATION_MEMBER invite inside the transaction', async () => {
    const { rules, permissions, tx } = setup();

    await rules.authorizeActor(tx, actorId, organizationId);

    expect(permissions.hasOrganizationPermissions).toHaveBeenCalledWith(
      actorId,
      organizationId,
      [{ resource: 'ORGANIZATION_MEMBER', action: 'invite' }],
      tx,
    );
  });

  it('forbids actors without the invite permission', async () => {
    const { rules, permissions, tx } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      rules.authorizeActor(tx, actorId, organizationId),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('InvitationRulesService.assertInvitableAccount', () => {
  it('allows an email with no account and reports no previous membership', async () => {
    const { rules, tx } = setup();

    await expect(
      rules.assertInvitableAccount(tx, organizationId, 'new@example.com'),
    ).resolves.toBeNull();
  });

  it('looks accounts up case-insensitively', async () => {
    const { rules, manager, tx } = setup();

    await rules.assertInvitableAccount(tx, organizationId, 'new@example.com');

    expect(manager.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'new@example.com', mode: 'insensitive' } },
      }),
    );
  });

  it('blocks deleted accounts', async () => {
    const { rules, manager, tx } = setup();
    manager.user.findFirst.mockResolvedValue({
      id: 'u',
      deletedAt: new Date(),
    });

    await expect(
      rules.assertInvitableAccount(tx, organizationId, 'gone@example.com'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('allows an account without any membership', async () => {
    const { rules, manager, tx } = setup();
    manager.user.findFirst.mockResolvedValue({ id: 'u', deletedAt: null });

    await expect(
      rules.assertInvitableAccount(tx, organizationId, 'a@example.com'),
    ).resolves.toBeNull();
  });

  it.each([
    ['an active membership', { status: 'ACTIVE', deletedAt: null }],
    ['a suspended membership', { status: 'SUSPENDED', deletedAt: null }],
    [
      'a removed suspended membership',
      { status: 'SUSPENDED', deletedAt: new Date() },
    ],
  ])('blocks accounts with %s', async (_, membership) => {
    const { rules, manager, tx } = setup();
    manager.user.findFirst.mockResolvedValue({ id: 'u', deletedAt: null });
    manager.organizationMember.findUnique.mockResolvedValue({
      id: 'm',
      ...membership,
    });

    await expect(
      rules.assertInvitableAccount(tx, organizationId, 'a@example.com'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('returns a removed ACTIVE membership so it can rejoin', async () => {
    const { rules, manager, tx } = setup();
    const removed = { id: 'm', status: 'ACTIVE', deletedAt: new Date() };
    manager.user.findFirst.mockResolvedValue({ id: 'u', deletedAt: null });
    manager.organizationMember.findUnique.mockResolvedValue(removed);

    await expect(
      rules.assertInvitableAccount(tx, organizationId, 'a@example.com'),
    ).resolves.toEqual(removed);
  });
});

describe('InvitationRulesService.assertCreatedAfterRemoval', () => {
  const removedAt = new Date('2026-01-10T00:00:00Z');

  it('accepts invitations when the account was never removed', () => {
    const { rules, links } = setup();

    expect(() =>
      rules.assertCreatedAfterRemoval(invitation(links), null),
    ).not.toThrow();
  });

  it('rejects invitations created at or before the removal', () => {
    const { rules, links } = setup();
    const previous = { id: 'm', status: 'ACTIVE', deletedAt: removedAt };

    for (const createdAt of [removedAt, new Date('2026-01-09T00:00:00Z')]) {
      expect(() =>
        rules.assertCreatedAfterRemoval(
          invitation(links, { createdAt }),
          previous,
        ),
      ).toThrow('Create a new invitation after member removal');
    }
  });

  it('accepts invitations created after the removal', () => {
    const { rules, links } = setup();

    expect(() =>
      rules.assertCreatedAfterRemoval(
        invitation(links, { createdAt: new Date('2026-01-11T00:00:00Z') }),
        { id: 'm', status: 'ACTIVE', deletedAt: removedAt },
      ),
    ).not.toThrow();
  });
});

describe('InvitationRulesService.assertPending', () => {
  it('accepts a live pending invitation', () => {
    const { rules, links } = setup();

    expect(() => rules.assertPending(invitation(links))).not.toThrow();
  });

  it.each(['ACCEPTED', 'REVOKED', 'EXPIRED'])(
    'rejects a %s invitation',
    (status) => {
      const { rules, links } = setup();

      expect(() =>
        rules.assertPending(invitation(links, { status })),
      ).toThrowError(expect.objectContaining({ status: 409 }));
    },
  );

  it('rejects a pending invitation past its expiry', () => {
    const { rules, links } = setup();

    expect(() =>
      rules.assertPending(
        invitation(links, { expiresAt: new Date(Date.now() - 1) }),
      ),
    ).toThrow('no longer pending');
  });
});

describe('InvitationRulesService token checks', () => {
  it('rebuilds the link for a matching token', () => {
    const { rules, links } = setup();

    expect(rules.createLink(invitation(links))).toBe(links.link(invitationId));
  });

  it('reports 503 instead of a link once the token secret changed', () => {
    const { rules } = setup();
    const stale = invitation(makeLinks('another-secret-'.repeat(6)));

    expect(rules.hasValidToken(stale)).toBe(false);
    expect(() => rules.createLink(stale)).toThrowError(
      expect.objectContaining({ status: 503 }),
    );
  });
});

describe('InvitationRulesService.findInvitation', () => {
  it('scopes the lookup to the organization', async () => {
    const { rules, manager, tx } = setup();

    await rules.findInvitation(tx, organizationId, invitationId);

    expect(manager.organizationInvitation.findFirst).toHaveBeenCalledWith({
      where: { id: invitationId, organizationId },
    });
  });
});
