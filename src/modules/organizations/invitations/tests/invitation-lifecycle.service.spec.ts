import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import type { PermissionsService } from '@/common/services/permissions.service.js';
import type { PrismaService } from '@/core/database/prisma.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';
import type { InvitationEmailService } from '../services/invitation-email.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import { buildInvitationServices } from './support/invitation-services.js';

const invitationId = '123e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const actorId = '323e4567-e89b-42d3-a456-426614174000';
const recipientId = '423e4567-e89b-42d3-a456-426614174000';
const secret = 'lifecycle-secret-'.repeat(4);

const makeLinks = (value = secret) =>
  new InvitationLinksService(
    new ConfigService({
      INVITATION_TOKEN_SECRET: value,
      FRONTEND_URL: 'http://frontend.invalid',
    }),
  );

function setup() {
  const links = makeLinks();
  const invitation = {
    id: invitationId,
    organizationId,
    email: 'member@example.com',
    tokenHash: links.hash(links.token(invitationId)),
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 3_600_000),
    createdAt: new Date(Date.now() - 120_000),
    resendCount: 0,
    lastRequestedAt: new Date(Date.now() - 120_000),
    deliveryVersion: 1,
    deliveryStatus: 'NOT_QUEUED',
  };
  const manager = {
    user: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: recipientId, email: 'member@example.com' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: organizationId }),
    },
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'membership' }),
      update: vi.fn().mockResolvedValue({ id: 'membership' }),
    },
    organizationInvitation: {
      findFirst: vi.fn(({ where }: { where: { status?: string } }) =>
        Promise.resolve(where.status === 'PENDING' ? null : invitation),
      ),
      findUnique: vi.fn().mockResolvedValue(invitation),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue(invitation),
      update: vi.fn().mockResolvedValue({ ...invitation, deliveryVersion: 2 }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    memberRole: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    role: { findFirst: vi.fn().mockResolvedValue({ id: 'member-role' }) },
  };
  const calls: string[] = [];
  const prisma = {
    serializableTransaction: vi.fn(
      (operation: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        operation(manager as unknown as Prisma.TransactionClient),
    ),
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  const email = {
    enqueue: vi.fn(() => {
      calls.push('enqueue');
      return Promise.resolve(true);
    }),
  };
  const logging = {
    audit: vi.fn().mockResolvedValue({ id: 'audit' }),
    publishCommittedAudit: vi.fn(() => {
      calls.push('publish');
    }),
  };
  const services = buildInvitationServices({
    prisma: prisma as unknown as PrismaService,
    permissions: permissions as unknown as PermissionsService,
    links,
    email: email as unknown as InvitationEmailService,
    logging: logging as unknown as LoggingService,
  });
  return {
    ...services,
    links,
    invitation,
    manager,
    prisma,
    permissions,
    email,
    logging,
    calls,
  };
}

describe('InvitationCreationService', () => {
  const dto = { email: '  Member@Example.COM ' } as never;

  it('stores a normalized email, the HMAC token hash and a 7 day expiry', async () => {
    const { creation, manager, links } = setup();
    const before = Date.now();

    await creation.create(actorId, organizationId, dto);

    const { data } = manager.organizationInvitation.create.mock.calls[0][0] as {
      data: {
        id: string;
        email: string;
        tokenHash: string;
        invitedById: string;
        expiresAt: Date;
      };
    };
    expect(data.email).toBe('member@example.com');
    expect(data.tokenHash).toBe(links.hash(links.token(data.id)));
    expect(data.invitedById).toBe(actorId);
    expect(data.expiresAt.getTime() - before).toBeGreaterThanOrEqual(
      7 * 24 * 3_600_000 - 1_000,
    );
  });

  it('never stores the raw token', async () => {
    const { creation, manager, links } = setup();

    await creation.create(actorId, organizationId, dto);

    const { data } = manager.organizationInvitation.create.mock.calls[0][0] as {
      data: { id: string };
    };
    expect(
      JSON.stringify(manager.organizationInvitation.create.mock.calls),
    ).not.toContain(links.token(data.id));
  });

  it('writes and enqueues nothing for callers without permission', async () => {
    const { creation, manager, permissions, email } = setup();
    permissions.hasOrganizationPermissions.mockResolvedValue(false);

    await expect(
      creation.create(actorId, organizationId, dto),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organizationInvitation.create).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a second pending invitation for the same email', async () => {
    const { creation, manager, email } = setup();
    manager.organizationInvitation.findFirst.mockResolvedValue({
      id: 'old',
    } as never);

    await expect(
      creation.create(actorId, organizationId, dto),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.organizationInvitation.create).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('replaces expired pending invitations deliberately', async () => {
    const { creation, manager, logging } = setup();
    manager.organizationInvitation.updateMany.mockResolvedValue({ count: 2 });

    await creation.create(actorId, organizationId, dto);

    expect(manager.organizationInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId,
        email: 'member@example.com',
        status: 'PENDING',
        expiresAt: { lte: expect.any(Date) },
      },
      data: { status: 'EXPIRED' },
    });
    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'organization.invitation.created',
        payload: expect.objectContaining({ expiredInvitationCount: 2 }),
      }),
      manager,
    );
  });

  it('creates strictly after a prior removal and revokes older pending invitations', async () => {
    const { creation, manager } = setup();
    const removedAt = new Date(Date.now() + 10_000);
    manager.user.findFirst.mockResolvedValue({
      id: recipientId,
      deletedAt: null,
    });
    manager.organizationMember.findUnique.mockResolvedValue({
      id: 'membership',
      status: 'ACTIVE',
      deletedAt: removedAt,
    });

    await creation.create(actorId, organizationId, dto);

    const { data } = manager.organizationInvitation.create.mock.calls[0][0] as {
      data: { createdAt: Date };
    };
    expect(data.createdAt.getTime()).toBeGreaterThan(removedAt.getTime());
    expect(manager.organizationInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        organizationId,
        email: 'member@example.com',
        status: 'PENDING',
        createdAt: { lte: removedAt },
      },
      data: { status: 'REVOKED', revokedAt: data.createdAt },
    });
  });

  it('publishes the audit before queueing the email', async () => {
    const { creation, calls } = setup();

    await creation.create(actorId, organizationId, dto);

    expect(calls).toEqual(['publish', 'enqueue']);
  });

  it('keeps the invitation and reports emailQueued false when the queue is down', async () => {
    const { creation, email, manager } = setup();
    email.enqueue.mockResolvedValue(false as never);

    await expect(
      creation.create(actorId, organizationId, dto),
    ).resolves.toEqual({ emailQueued: false });
    expect(manager.organizationInvitation.create).toHaveBeenCalledOnce();
  });

  it('neither publishes nor queues when the audit write fails', async () => {
    const { creation, logging, email } = setup();
    logging.audit.mockRejectedValue(new Error('audit down'));

    await expect(creation.create(actorId, organizationId, dto)).rejects.toThrow(
      'audit down',
    );
    expect(logging.publishCommittedAudit).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
  });
});

describe('InvitationManagementService', () => {
  it('returns 404 for an invitation outside the organization', async () => {
    const { management, manager } = setup();
    manager.organizationInvitation.findFirst.mockResolvedValue(null);

    for (const action of [
      () => management.resend(actorId, organizationId, invitationId),
      () => management.copyLink(actorId, organizationId, invitationId),
      () => management.revoke(actorId, organizationId, invitationId),
    ]) {
      await expect(action()).rejects.toMatchObject({ status: 404 });
    }
    expect(manager.organizationInvitation.findFirst).toHaveBeenCalledWith({
      where: { id: invitationId, organizationId },
    });
  });

  it('copies a link without writing, auditing or emailing', async () => {
    const { management, manager, logging, email, links } = setup();

    const result = await management.copyLink(
      actorId,
      organizationId,
      invitationId,
    );

    expect(result.inviteLink).toBe(links.link(invitationId));
    expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
    expect(logging.audit).not.toHaveBeenCalled();
    expect(email.enqueue).not.toHaveBeenCalled();
  });

  it('resets delivery state on resend and queues only after publishing', async () => {
    const { management, manager, calls } = setup();

    await expect(
      management.resend(actorId, organizationId, invitationId),
    ).resolves.toEqual({ emailQueued: true });

    expect(manager.organizationInvitation.update).toHaveBeenCalledWith({
      where: { id: invitationId },
      data: expect.objectContaining({
        resendCount: { increment: 1 },
        deliveryVersion: { increment: 1 },
        deliveryStatus: 'NOT_QUEUED',
        sentAt: null,
      }),
    });
    expect(calls).toEqual(['publish', 'enqueue']);
  });

  it('refuses to revoke an accepted invitation', async () => {
    const { management, manager } = setup();
    manager.organizationInvitation.findFirst.mockResolvedValue({
      id: invitationId,
      status: 'ACCEPTED',
    } as never);

    await expect(
      management.revoke(actorId, organizationId, invitationId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects invalid pagination before opening a transaction', async () => {
    const { management, prisma } = setup();

    await expect(
      management.list(actorId, organizationId, { page: 0, limit: 20 }),
    ).rejects.toMatchObject({ status: 422 });
    expect(prisma.serializableTransaction).not.toHaveBeenCalled();
  });

  it('scopes listings to the organization and applies filters', async () => {
    const { management, manager } = setup();

    await management.list(actorId, organizationId, {
      page: 2,
      limit: 5,
      email: 'mem',
      status: 'PENDING',
    });

    expect(manager.organizationInvitation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId,
          email: { contains: 'mem', mode: 'insensitive' },
          status: 'PENDING',
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: 5,
        take: 5,
      }),
    );
  });

  it('treats the EXPIRED filter as stored or clock-expired pending rows', async () => {
    const { management, manager } = setup();

    await management.list(actorId, organizationId, { status: 'EXPIRED' });

    const { where } = manager.organizationInvitation.findMany.mock
      .calls[0][0] as { where: { OR: unknown[] } };
    expect(where.OR).toEqual([
      { status: 'EXPIRED' },
      { status: 'PENDING', expiresAt: { lte: expect.any(Date) } },
    ]);
  });

  it('never exposes the token hash in listings', async () => {
    const { management, manager, invitation } = setup();
    manager.organizationInvitation.findMany.mockResolvedValue([invitation]);

    await management.list(actorId, organizationId, {});

    const { select } = manager.organizationInvitation.findMany.mock
      .calls[0][0] as { select: Record<string, boolean> };
    expect(select).not.toHaveProperty('tokenHash');
  });
});

describe('InvitationAcceptanceService', () => {
  const token = (links: InvitationLinksService) => links.token(invitationId);

  it('rejects unknown tokens with 400 and changes nothing', async () => {
    const { acceptance, manager } = setup();
    manager.organizationInvitation.findUnique.mockResolvedValue(null);

    await expect(
      acceptance.accept(recipientId, 'unknown-token'),
    ).rejects.toMatchObject({ status: 400 });
    expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
  });

  it('rejects tokens that no longer match after the secret rotated', async () => {
    const { acceptance, manager, invitation } = setup();
    const rotated = makeLinks('rotated-secret-'.repeat(5));
    manager.organizationInvitation.findUnique.mockResolvedValue({
      ...invitation,
      tokenHash: rotated.hash(rotated.token(invitationId)),
    });

    await expect(
      acceptance.accept(recipientId, 'any-token'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects deleted accepting users with 401', async () => {
    const { acceptance, manager, links } = setup();
    manager.user.findUnique.mockResolvedValue(null);

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('requires the signed-in email to match the invited email', async () => {
    const { acceptance, manager, links } = setup();
    manager.user.findUnique.mockResolvedValue({
      id: recipientId,
      email: 'someone-else@example.com',
    });

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).rejects.toMatchObject({ status: 403 });
    expect(manager.organizationMember.create).not.toHaveBeenCalled();
  });

  it('compares emails case-insensitively', async () => {
    const { acceptance, manager, links } = setup();
    manager.user.findUnique.mockResolvedValue({
      id: recipientId,
      email: '  Member@Example.com ',
    });

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).resolves.toMatchObject({ organizationId });
  });

  it('refuses unavailable organizations with 409', async () => {
    const { acceptance, manager, links } = setup();
    manager.organization.findUnique.mockResolvedValue(null);

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('fails with 503 when the organization has no MEMBER role', async () => {
    const { acceptance, manager, links } = setup();
    manager.role.findFirst.mockResolvedValue(null);

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).rejects.toMatchObject({ status: 503 });
    expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
  });

  it('only ever assigns the local MEMBER role', async () => {
    const { acceptance, manager, links } = setup();

    await acceptance.accept(recipientId, token(links));

    expect(manager.role.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId,
        name: 'MEMBER',
        isSystem: false,
        deletedAt: null,
      },
      select: { id: true },
    });
    expect(manager.organizationMember.create).toHaveBeenCalledWith({
      data: {
        organizationId,
        userId: recipientId,
        status: 'ACTIVE',
        memberRoles: { create: { roleId: 'member-role' } },
      },
      select: { id: true },
    });
  });

  it('publishes exactly one audit event after the transaction', async () => {
    const { acceptance, logging, links } = setup();

    await acceptance.accept(recipientId, token(links));

    expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
  });

  it('restores a removed member and resets historical roles to MEMBER only', async () => {
    const { acceptance, manager, logging, links, invitation } = setup();
    const removedAt = new Date(Date.now() - 60_000);
    manager.user.findFirst.mockResolvedValue({
      id: recipientId,
      deletedAt: null,
    });
    manager.organizationMember.findUnique.mockResolvedValue({
      id: 'old-membership',
      status: 'ACTIVE',
      deletedAt: removedAt,
    });
    manager.organizationInvitation.findUnique.mockResolvedValue({
      ...invitation,
      createdAt: new Date(removedAt.getTime() + 1_000),
    });
    manager.memberRole.findMany.mockResolvedValue([{ roleId: 'old-admin' }]);

    await acceptance.accept(recipientId, token(links));

    expect(manager.memberRole.updateMany).toHaveBeenCalledWith({
      where: { organizationMemberId: 'old-membership', deletedAt: null },
      data: { deletedAt: expect.any(Date) },
    });
    expect(manager.memberRole.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          organizationMemberId: 'old-membership',
          roleId: 'member-role',
        },
        update: { deletedAt: null },
      }),
    );
    expect(manager.organizationMember.create).not.toHaveBeenCalled();
    expect(logging.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          membershipReactivated: true,
          previousRoleIds: ['old-admin'],
        }),
      }),
      manager,
    );
  });

  it('refuses invitations created before the member was removed', async () => {
    const { acceptance, manager, links, invitation } = setup();
    const removedAt = new Date();
    manager.user.findFirst.mockResolvedValue({
      id: recipientId,
      deletedAt: null,
    });
    manager.organizationMember.findUnique.mockResolvedValue({
      id: 'old-membership',
      status: 'ACTIVE',
      deletedAt: removedAt,
    });
    manager.organizationInvitation.findUnique.mockResolvedValue({
      ...invitation,
      createdAt: new Date(removedAt.getTime() - 1_000),
    });

    await expect(
      acceptance.accept(recipientId, token(links)),
    ).rejects.toMatchObject({ status: 409 });
    expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
    expect(manager.memberRole.upsert).not.toHaveBeenCalled();
  });
});
