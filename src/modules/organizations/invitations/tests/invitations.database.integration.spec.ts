import 'dotenv/config';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigService } from '@nestjs/config';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PrismaClient, Prisma } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { PermissionsService } from '@/common/services/permissions.service.js';
import { LoggingService } from '@/modules/logging/logging.service.js';
import { InvitationEmailService } from '../services/invitation-email.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import { buildInvitationFlow } from './support/invitation-services.js';

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === 'true';
const tokenSecret = 'database-invitation-secret-'.repeat(4);

describe.runIf(runDatabaseTests)('Invitations database integration', () => {
  const schema = `invitation_test_${randomUUID().replaceAll('-', '')}`;
  let ddl: pg.Client;
  let db: PrismaClient;
  let ownerId: string;
  let organizationId: string;
  let memberRoleId: string;

  const createService = () => {
    const host = {
      async $transaction<T>(
        operation: (manager: Prisma.TransactionClient) => Promise<T>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) {
        return db.$transaction((manager) => operation(manager), options);
      },
      serializableTransaction<T>(
        operation: (manager: Prisma.TransactionClient) => Promise<T>,
      ) {
        return PrismaService.prototype.serializableTransaction.call(
          this,
          operation,
        ) as Promise<T>;
      },
    } as unknown as PrismaService;
    const permissions = {
      assertActiveActor: vi.fn().mockResolvedValue(undefined),
      hasOrganizationPermissions: vi.fn().mockResolvedValue(true),
    };
    const logging = {
      audit: vi.fn().mockResolvedValue({ id: randomUUID() }),
      publishCommittedAudit: vi.fn(),
    };
    const email = { enqueue: vi.fn().mockResolvedValue(true) };
    const links = new InvitationLinksService(
      new ConfigService({
        FRONTEND_URL: 'http://frontend.invalid',
        INVITATION_TOKEN_SECRET: tokenSecret,
      }),
    );
    return {
      service: buildInvitationFlow({
        prisma: host,
        permissions: permissions as unknown as PermissionsService,
        links: links,
        email: email as unknown as InvitationEmailService,
        logging: logging as unknown as LoggingService,
      }),
      links,
      email,
    };
  };

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const hostname = new URL(databaseUrl).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      throw new Error('Invitation database tests require local PostgreSQL');
    }

    ddl = new pg.Client({ connectionString: databaseUrl });
    await ddl.connect();
    await ddl.query(`CREATE SCHEMA "${schema}"`);
    await ddl.query(`SET search_path TO "${schema}"`);
    const migrations = await readdir('prisma/migrations', {
      withFileTypes: true,
    });
    for (const migration of migrations
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const sql = await readFile(
        `prisma/migrations/${migration.name}/migration.sql`,
        'utf8',
      );
      if (/\bpublic\s*\./i.test(sql)) {
        throw new Error('Migration explicitly targets application schema');
      }
      await ddl.query(sql);
    }
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: databaseUrl }, { schema }),
    });
  }, 30_000);

  beforeEach(async () => {
    await db.organizationInvitation.deleteMany();
    await db.memberRole.deleteMany();
    await db.organizationMember.deleteMany();
    await db.role.deleteMany();
    await db.organization.deleteMany();
    await db.user.deleteMany();

    const owner = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        username: randomUUID(),
        firstName: 'Invitation',
        lastName: 'Owner',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });
    ownerId = owner.id;
    const organization = await db.organization.create({
      data: {
        name: 'Invitation Test Organization',
        slug: randomUUID(),
        ownerId,
      },
    });
    organizationId = organization.id;
    await db.organizationMember.create({
      data: { organizationId, userId: ownerId, status: 'ACTIVE' },
    });
    const role = await db.role.create({
      data: { organizationId, name: 'MEMBER', isSystem: false },
    });
    memberRoleId = role.id;
  });

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ddl?.end();
  });

  it('creates a pending invitation with a unique token hash', async () => {
    const { service, links } = createService();
    const result = await service.create(ownerId, organizationId, {
      email: 'member@example.com',
    });
    const invitation = await db.organizationInvitation.findFirstOrThrow();

    expect(result).toEqual({ emailQueued: true });
    expect(invitation.status).toBe('PENDING');
    expect(invitation.tokenHash).toBe(links.hash(links.token(invitation.id)));
    expect(invitation.deliveryStatus).toBe('NOT_QUEUED');
  });

  it('prevents duplicate pending invitations at the service boundary', async () => {
    const { service } = createService();
    await service.create(ownerId, organizationId, {
      email: 'member@example.com',
    });

    await expect(
      service.create(ownerId, organizationId, {
        email: 'MEMBER@example.com',
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('blocks inviting an existing member whose email differs only by case', async () => {
    const member = await db.user.create({
      data: {
        email: 'existing@example.com',
        username: randomUUID(),
        firstName: 'Existing',
        lastName: 'Member',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });
    await db.organizationMember.create({
      data: { organizationId, userId: member.id, status: 'ACTIVE' },
    });
    const { service } = createService();

    await expect(
      service.create(ownerId, organizationId, {
        email: '  EXISTING@Example.com ',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.organizationInvitation.count()).toBe(0);
  });

  it('allows only one pending invitation when creation races', async () => {
    const first = createService().service;
    const second = createService().service;
    const results = await Promise.allSettled([
      first.create(ownerId, organizationId, {
        email: 'racing@example.com',
      }),
      second.create(ownerId, organizationId, {
        email: 'RACING@example.com',
      }),
    ]);

    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(
      await db.organizationInvitation.count({
        where: {
          organizationId,
          email: 'racing@example.com',
          status: 'PENDING',
        },
      }),
    ).toBe(1);
  });

  it('accepts an invitation and provisions the local MEMBER role', async () => {
    const { service, links } = createService();
    const recipient = await db.user.create({
      data: {
        email: 'member@example.com',
        emailVerifiedAt: new Date(),
        username: randomUUID(),
        firstName: 'Invitation',
        lastName: 'Recipient',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });
    await service.create(ownerId, organizationId, {
      email: recipient.email,
    });
    const invitation = await db.organizationInvitation.findFirstOrThrow();

    const result = await service.accept(
      recipient.id,
      links.token(invitation.id),
    );
    const membership = await db.organizationMember.findUniqueOrThrow({
      where: {
        organizationId_userId: {
          organizationId,
          userId: recipient.id,
        },
      },
      include: { memberRoles: true },
    });

    expect(result.membershipId).toBe(membership.id);
    expect(membership.memberRoles).toHaveLength(1);
    expect(membership.memberRoles[0]?.roleId).toBe(memberRoleId);
  });

  it('revokes an invitation idempotently', async () => {
    const { service } = createService();
    await service.create(ownerId, organizationId, {
      email: 'member@example.com',
    });
    const invitation = await db.organizationInvitation.findFirstOrThrow();

    await service.revoke(ownerId, organizationId, invitation.id);
    await service.revoke(ownerId, organizationId, invitation.id);

    const stored = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitation.id },
    });
    expect(stored.status).toBe('REVOKED');
  });

  it('does not allow accepting a revoked invitation', async () => {
    const { service, links } = createService();
    await service.create(ownerId, organizationId, {
      email: 'revoked@example.com',
    });
    const invitation = await db.organizationInvitation.findFirstOrThrow();
    await service.revoke(ownerId, organizationId, invitation.id);
    const recipient = await db.user.create({
      data: {
        email: 'revoked@example.com',
        emailVerifiedAt: new Date(),
        username: randomUUID(),
        firstName: 'Revoked',
        lastName: 'Recipient',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });

    await expect(
      service.accept(recipient.id, links.token(invitation.id)),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await db.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId,
            userId: recipient.id,
          },
        },
      }),
    ).toBeNull();
  });
});
