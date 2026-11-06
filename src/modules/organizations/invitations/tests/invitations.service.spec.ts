import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { InvitationEmailService } from '../services/invitation-email.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import { buildInvitationFlow } from './support/invitation-services.js';
import type { Prisma } from '@/generated/prisma/client.js';

const invitationId = '123e4567-e89b-42d3-a456-426614174000';
const organizationId = '223e4567-e89b-42d3-a456-426614174000';
const actorId = '323e4567-e89b-42d3-a456-426614174000';
const tokenSecret = 'test-invitation-secret-'.repeat(4);

function createInvitation() {
  const links = new InvitationLinksService(
    new ConfigService({
      INVITATION_TOKEN_SECRET: tokenSecret,
      FRONTEND_URL: 'http://frontend.invalid',
    }),
  );
  const tokenHash = links.hash(links.token(invitationId));
  return {
    id: invitationId,
    organizationId,
    email: 'member@example.com',
    tokenHash,
    status: 'PENDING',
    expiresAt: new Date(Date.now() + 60_000),
    invitedById: actorId,
    createdAt: new Date(Date.now() - 120_000),
    resendCount: 0,
    lastRequestedAt: new Date(Date.now() - 120_000),
    deliveryVersion: 1,
    deliveryStatus: 'NOT_QUEUED',
    sentAt: null,
  };
}

function setup(overrides: Record<string, unknown> = {}) {
  const invitation = createInvitation();
  const manager = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: actorId,
        email: 'member@example.com',
      }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    organizationInvitation: {
      findFirst: vi.fn(({ where }: { where: { status?: string } }) =>
        where.status === 'PENDING' ? null : Promise.resolve(invitation),
      ),
      findUnique: vi.fn().mockResolvedValue(invitation),
      findMany: vi.fn().mockResolvedValue([invitation]),
      count: vi.fn().mockResolvedValue(1),
      create: vi.fn().mockResolvedValue(invitation),
      update: vi.fn().mockResolvedValue({
        ...invitation,
        resendCount: 1,
        deliveryVersion: 2,
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    organization: {
      findUnique: vi.fn().mockResolvedValue({ id: organizationId }),
    },
    organizationMember: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'membership-id' }),
      update: vi.fn().mockResolvedValue({ id: 'membership-id' }),
    },
    memberRole: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      upsert: vi.fn().mockResolvedValue({}),
    },
    role: {
      findFirst: vi.fn().mockResolvedValue({ id: 'member-role-id' }),
    },
  };
  const audit = vi.fn().mockResolvedValue({ id: 'audit-id' });
  const logging = {
    audit,
    publishCommittedAudit: vi.fn(),
  };
  const permissions = {
    assertActiveActor: vi.fn().mockResolvedValue(undefined),
    hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
  };
  const email = {
    enqueue: vi.fn().mockResolvedValue(true),
  };
  const prisma = {
    serializableTransaction: (
      operation: (client: Prisma.TransactionClient) => Promise<unknown>,
    ) => operation(manager as unknown as Prisma.TransactionClient),
  };
  const service = buildInvitationFlow({
    prisma: prisma as unknown as PrismaService,
    permissions: permissions as unknown as PermissionsService,
    links: new InvitationLinksService(
      new ConfigService({
        INVITATION_TOKEN_SECRET: tokenSecret,
        FRONTEND_URL: 'http://frontend.invalid',
      }),
    ),
    email: email as unknown as InvitationEmailService,
    logging: logging as unknown as LoggingService,
  });

  return {
    service,
    invitation,
    manager,
    audit,
    email,
    logging,
    permissions,
    ...overrides,
  };
}

describe('Invitation services', () => {
  it('creates an invitation and enqueues its email after the transaction', async () => {
    const { service, manager, audit, email, logging } = setup();

    await expect(
      service.create(actorId, organizationId, {
        email: ' Member@Example.com ',
      }),
    ).resolves.toEqual({ emailQueued: true });

    expect(manager.organizationInvitation.create).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledOnce();
    expect(logging.publishCommittedAudit).toHaveBeenCalledWith({
      id: 'audit-id',
    });
    expect(email.enqueue).toHaveBeenCalledOnce();
  });

  it('resends a pending invitation and increments its delivery version', async () => {
    const { service, manager, email, logging } = setup();

    await expect(
      service.resend(actorId, organizationId, invitationId),
    ).resolves.toEqual({ emailQueued: true });

    expect(manager.organizationInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: invitationId },
        data: expect.objectContaining({
          deliveryStatus: 'NOT_QUEUED',
          sentAt: null,
        }),
      }),
    );
    expect(email.enqueue).toHaveBeenCalledWith(invitationId, 2);
    expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
  });

  it('returns a protected link without changing the invitation', async () => {
    const { service, invitation, manager } = setup();

    await expect(
      service.copyLink(actorId, organizationId, invitationId),
    ).resolves.toEqual({
      id: invitationId,
      inviteLink: expect.stringContaining('#token='),
      expiresAt: invitation.expiresAt,
    });

    expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
  });

  it('revokes a pending invitation and publishes its audit after commit', async () => {
    const { service, manager, logging } = setup();

    await expect(
      service.revoke(actorId, organizationId, invitationId),
    ).resolves.toBeUndefined();

    expect(manager.organizationInvitation.update).toHaveBeenCalledWith({
      where: { id: invitationId },
      data: { status: 'REVOKED', revokedAt: expect.any(Date) },
    });
    expect(logging.publishCommittedAudit).toHaveBeenCalledOnce();
  });

  it('lists invitation metadata with effective expired status', async () => {
    const { service, invitation } = setup();
    invitation.expiresAt = new Date(Date.now() - 1);

    await expect(
      service.list(actorId, organizationId, {
        page: 1,
        limit: 20,
        status: 'EXPIRED',
      }),
    ).resolves.toMatchObject({
      total: 1,
      page: 1,
      limit: 20,
      items: [{ id: invitationId, role: 'MEMBER', status: 'EXPIRED' }],
    });
  });

  it('accepts a valid invitation and creates a member role assignment', async () => {
    const { service, manager } = setup();
    const links = new InvitationLinksService(
      new ConfigService({ INVITATION_TOKEN_SECRET: tokenSecret }),
    );

    await expect(
      service.accept(actorId, links.token(invitationId)),
    ).resolves.toEqual({
      organizationId,
      membershipId: 'membership-id',
    });

    expect(manager.organizationInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: invitationId, status: 'PENDING' },
      }),
    );
    expect(manager.organizationMember.create).toHaveBeenCalledOnce();
  });

  it('rejects resend for an accepted invitation', async () => {
    const { service, invitation } = setup();
    invitation.status = 'ACCEPTED';

    await expect(
      service.resend(actorId, organizationId, invitationId),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('rejects resend during the cooldown window', async () => {
    const { service, invitation } = setup();
    invitation.lastRequestedAt = new Date();

    await expect(
      service.resend(actorId, organizationId, invitationId),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('rejects resend after the resend limit is reached', async () => {
    const { service, invitation } = setup();
    invitation.resendCount = 5;

    await expect(
      service.resend(actorId, organizationId, invitationId),
    ).rejects.toMatchObject({ status: 429 });
  });

  it.each(['EXPIRED', 'REVOKED'])(
    'rejects copying a %s invitation link',
    async (status) => {
      const { service, invitation } = setup();
      invitation.status = status;

      await expect(
        service.copyLink(actorId, organizationId, invitationId),
      ).rejects.toMatchObject({ status: 409 });
    },
  );

  it('makes repeated revoke idempotent without writing another audit', async () => {
    const { service, invitation, audit } = setup();
    invitation.status = 'REVOKED';

    await expect(
      service.revoke(actorId, organizationId, invitationId),
    ).resolves.toBeUndefined();

    expect(audit).not.toHaveBeenCalled();
  });
});
