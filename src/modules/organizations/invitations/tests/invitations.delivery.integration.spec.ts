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
import { PrismaClient } from '@/generated/prisma/client.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import type { EmailService } from '../services/email.service.js';
import type { LoggingService } from '@/modules/logging/logging.service.js';

const runDeliveryTests = process.env.RUN_INVITATION_DELIVERY_TESTS === 'true';
const tokenSecret = 'delivery-invitation-secret-'.repeat(4);

describe.runIf(runDeliveryTests)('Invitation delivery integration', () => {
  const schema = `delivery_test_${randomUUID().replaceAll('-', '')}`;
  let ddl: pg.Client;
  let db: PrismaClient;
  let invitationId: string;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    const hostname = new URL(databaseUrl).hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
      throw new Error('Invitation delivery tests require local PostgreSQL');
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

    const sender = await db.user.create({
      data: {
        email: `${randomUUID()}@example.com`,
        username: randomUUID(),
        firstName: 'Delivery',
        lastName: 'Sender',
        birthDate: new Date('2000-01-01'),
        hashedPassword: 'fixture',
      },
    });
    const organization = await db.organization.create({
      data: {
        name: 'Delivery Test Organization',
        slug: randomUUID(),
        ownerId: sender.id,
      },
    });
    const links = new InvitationLinksService(
      new ConfigService({ INVITATION_TOKEN_SECRET: tokenSecret }),
    );
    const invitation = await db.organizationInvitation.create({
      data: {
        organizationId: organization.id,
        invitedById: sender.id,
        email: 'recipient@example.com',
        tokenHash: links.hash(links.token(randomUUID())),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    invitationId = invitation.id;
  }, 30_000);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await ddl?.end();
  });

  beforeEach(async () => {
    const links = new InvitationLinksService(
      new ConfigService({ INVITATION_TOKEN_SECRET: tokenSecret }),
    );
    await db.organizationInvitation.update({
      where: { id: invitationId },
      data: {
        tokenHash: links.hash(links.token(invitationId)),
        status: 'PENDING',
        deliveryStatus: 'QUEUED',
        deliveryVersion: 1,
        sentAt: null,
      },
    });
  });

  it('records SENT only after the email provider succeeds', async () => {
    const links = new InvitationLinksService(
      new ConfigService({ INVITATION_TOKEN_SECRET: tokenSecret }),
    );
    const email = {
      sendInvitationEmail: vi.fn().mockResolvedValue(undefined),
    };
    const logging = { application: vi.fn() };
    const service = new InvitationDeliveryService(
      db as unknown as PrismaService,
      links,
      email as unknown as EmailService,
      logging as unknown as LoggingService,
    );
    const invitation = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    await service.deliver({
      invitationId,
      version: invitation.deliveryVersion,
    });

    const stored = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    expect(stored.deliveryStatus).toBe('SENT');
    expect(stored.sentAt).not.toBeNull();
    expect(email.sendInvitationEmail).toHaveBeenCalledOnce();
  });

  it('records FAILED and rethrows when the provider rejects the email', async () => {
    await db.organizationInvitation.update({
      where: { id: invitationId },
      data: { deliveryVersion: 2 },
    });
    const links = new InvitationLinksService(
      new ConfigService({ INVITATION_TOKEN_SECRET: tokenSecret }),
    );
    const email = {
      sendInvitationEmail: vi
        .fn()
        .mockRejectedValue(new Error('SMTP failure')),
    };
    const logging = { application: vi.fn() };
    const service = new InvitationDeliveryService(
      db as unknown as PrismaService,
      links,
      email as unknown as EmailService,
      logging as unknown as LoggingService,
    );
    const invitation = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });

    await expect(
      service.deliver({
        invitationId,
        version: invitation.deliveryVersion,
      }),
    ).rejects.toThrow('Invitation email delivery failed');

    const stored = await db.organizationInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });
    expect(stored.deliveryStatus).toBe('FAILED');
  });
});
