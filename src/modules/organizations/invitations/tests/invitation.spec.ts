import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { InputValidationPipe } from '@/common/pipes/validation.pipe.js';
import { PrismaService } from '@/core/database/prisma.service.js';
import { InvitationEmailService } from '../services/invitation-email.service.js';
import { InvitationDeliveryService } from '../services/invitation-delivery.service.js';
import { EmailService } from '../services/email.service.js';
import { InvitationLinksService } from '../services/invitation-links.service.js';
import {
  AcceptInvitationDto,
  CreateInvitationDto,
} from '../dto/invitation.dto.js';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { EmailNotificationWorker } from '../workers/email-notification.worker.js';
import { EmailJobNames } from '@/common/enums/email-job-names.enum.js';
import { INVITATION_EMAIL_QUEUE } from '../constants/email-queue.constant.js';
import type { SendInvitationJobData } from '../interfaces/send-invitation-job.interface.js';
import type { Job, Queue } from 'bullmq';
import { envValidationSchema } from '@/core/config/env.validation.js';
import { InvitationsService } from '../services/invitations.service.js';
import type { PermissionsService } from '@/common/services/permissions.service.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { safeEmailErrorDetails } from '../utils/email-error.util.js';
import { LoggingService } from '@/modules/logging/logging.service.js';

const config = new ConfigService({
  INVITATION_TOKEN_SECRET: 'test-invitation-secret-'.repeat(4),
  FRONTEND_URL: 'http://frontend.invalid',
  SMTP_FROM: 'sender@example.com',
});
const links = new InvitationLinksService(config);
const application = vi.fn();
const logging = { application } as unknown as LoggingService;

describe('Safe email error diagnostics', () => {
  it('keeps allowlisted codes without raw SMTP responses or credentials', () => {
    expect(
      safeEmailErrorDetails({
        code: 'EAUTH',
        responseCode: 535,
        message: 'private credentials',
        response: 'private SMTP response',
      }),
    ).toEqual({ code: 'EAUTH', responseCode: 535 });
  });

  it.each([
    null,
    'private error',
    { code: 'private token', responseCode: 'private response' },
  ])('does not expose unknown error properties', (error) => {
    expect(safeEmailErrorDetails(error)).toEqual({ code: 'UNKNOWN' });
  });
});

describe('Invitation acceptance token verification', () => {
  function setup(currentLinks = links) {
    const token = links.token('invitation');
    const invitation = {
      id: 'invitation',
      organizationId: 'organization',
      email: 'recipient@example.com',
      tokenHash: links.hash(token),
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const manager = {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ id: 'recipient', email: invitation.email }),
        findFirst: vi
          .fn()
          .mockResolvedValue({ id: 'recipient', deletedAt: null }),
      },
      organizationInvitation: {
        findUnique: vi.fn(
          async ({ where }: { where: { tokenHash: string } }) =>
            where.tokenHash === invitation.tokenHash ? invitation : null,
        ),
        update: vi.fn().mockResolvedValue({}),
      },
      organization: {
        findUnique: vi.fn().mockResolvedValue({ id: 'organization' }),
      },
      organizationMember: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'membership' }),
      },
      role: { findFirst: vi.fn().mockResolvedValue({ id: 'member-role' }) },
    };
    const prisma = {
      serializableTransaction: (
        operation: (client: Prisma.TransactionClient) => Promise<unknown>,
      ) => operation(manager as unknown as Prisma.TransactionClient),
    } as unknown as PrismaService;
    const service = new InvitationsService(
      prisma,
      {} as PermissionsService,
      currentLinks,
      {} as InvitationEmailService,
    );
    return { service, token, manager };
  }

  it('accepts a valid token and provisions the recipient membership', async () => {
    const { service, token, manager } = setup();
    await expect(service.accept('recipient', token)).resolves.toEqual({
      organizationId: 'organization',
      membershipId: 'membership',
    });
    expect(manager.organizationInvitation.update).toHaveBeenCalledWith({
      where: { id: 'invitation', status: 'PENDING' },
      data: {
        status: 'ACCEPTED',
        acceptedAt: expect.any(Date),
        acceptedById: 'recipient',
      },
    });
    expect(manager.organizationMember.create).toHaveBeenCalledOnce();
  });

  it.each(['unknown token', 'changed secret'])(
    'rejects %s without consuming the invitation or creating membership',
    async (scenario) => {
      const currentLinks =
        scenario === 'changed secret'
          ? new InvitationLinksService(
              new ConfigService({ INVITATION_TOKEN_SECRET: 'b'.repeat(64) }),
            )
          : links;
      const { service, token, manager } = setup(currentLinks);
      await expect(
        service.accept(
          'recipient',
          scenario === 'unknown token' ? 'a'.repeat(64) : token,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(manager.organizationInvitation.update).not.toHaveBeenCalled();
      expect(manager.organizationMember.create).not.toHaveBeenCalled();
    },
  );
});

describe('Invitation input and links', () => {
  const validate = (
    metatype: typeof CreateInvitationDto | typeof AcceptInvitationDto,
    value: Record<string, unknown>,
  ) => new InputValidationPipe().transform(value, { type: 'body', metatype });
  it('normalizes email and rejects arbitrary role assignment', async () => {
    await expect(
      validate(CreateInvitationDto, { email: ' User@Example.com ' }),
    ).resolves.toMatchObject({ email: 'user@example.com' });
    await expect(
      validate(CreateInvitationDto, {
        email: 'user@example.com',
        role: 'ADMIN',
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
  it.each([
    {},
    { email: 123 },
    { email: 'bad' },
    { email: null },
    { email: 'user@example.com', organizationId: 'spoof' },
  ])('rejects invalid invitation input %j', async (value) => {
    await expect(validate(CreateInvitationDto, value)).rejects.toMatchObject({
      status: 422,
    });
  });
  it.each(['', 'x'.repeat(64), 'a'.repeat(65)])(
    'rejects malformed token %s',
    async (token) => {
      await expect(
        validate(AcceptInvitationDto, { token }),
      ).rejects.toMatchObject({ status: 422 });
    },
  );
  it('makes stable, invitation-specific links with a token fragment', () => {
    expect(links.token('first')).toMatch(/^[a-f0-9]{64}$/);
    expect(links.token('first')).toBe(links.token('first'));
    expect(links.token('first')).not.toBe(links.token('second'));
    const url = new URL(links.link('first'));
    expect(url.search).toBe('');
    expect(url.hash).toBe(`#token=${links.token('first')}`);
  });
  it('fails explicitly without token or frontend configuration', () => {
    expect(() =>
      new InvitationLinksService(new ConfigService()).token('id'),
    ).toThrow();
    expect(() =>
      new InvitationLinksService(
        new ConfigService({ INVITATION_TOKEN_SECRET: 'a'.repeat(64) }),
      ).link('id'),
    ).toThrow();
  });
});

describe('Invitation email delivery', () => {
  const invitationId = '123e4567-e89b-42d3-a456-426614174000';
  const findUnique = vi.fn();
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const sendMail = vi.fn();
  const add = vi.fn();
  const queueOn = vi.fn();
  let service: InvitationDeliveryService;
  let producer: InvitationEmailService;
  const row = () => ({
    id: invitationId,
    email: 'recipient@example.com',
    deliveryVersion: 1,
    deliveryStatus: 'QUEUED',
    status: 'PENDING',
    tokenHash: links.hash(links.token(invitationId)),
    expiresAt: new Date(Date.now() + 60_000),
    organization: { name: 'Fixture', isActive: true, deletedAt: null },
  });
  beforeEach(() => {
    vi.clearAllMocks();
    const prisma = {
      organizationInvitation: { findUnique, updateMany },
    } as unknown as PrismaService;
    const smtp = new EmailService(
      new ConfigService({
        SMTP_HOST: 'smtp.invalid',
        SMTP_PORT: 587,
        SMTP_FROM: 'sender@example.com',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
      }),
    );
    Reflect.set(smtp, 'transport', { sendMail });
    service = new InvitationDeliveryService(prisma, links, smtp, logging);
    producer = new InvitationEmailService(
      prisma,
      {
        add,
        on: queueOn,
      } as unknown as Queue<SendInvitationJobData>,
      logging,
    );
    findUnique.mockResolvedValue(row());
    sendMail.mockResolvedValue({ accepted: ['recipient@example.com'] });
  });
  it('records SENT only after SMTP accepts and uses text rather than unescaped HTML', async () => {
    await service.deliver({ invitationId, version: 1 });
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'recipient@example.com',
        text: expect.stringContaining(links.link(invitationId)),
      }),
    );
    expect(sendMail.mock.calls[0][0]).not.toHaveProperty('html');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { deliveryStatus: 'SENT', sentAt: expect.any(Date) },
      }),
    );
  });
  it('rethrows a safe error and permits retry after a failed send', async () => {
    sendMail
      .mockRejectedValueOnce(new Error('sensitive SMTP failure'))
      .mockResolvedValueOnce({ accepted: ['recipient@example.com'] });
    await expect(service.deliver({ invitationId, version: 1 })).rejects.toThrow(
      'Invitation email delivery failed',
    );
    await service.deliver({ invitationId, version: 1 });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
  it('identifies SMTP failures without logging sensitive error details', async () => {
    sendMail.mockRejectedValueOnce(
      Object.assign(new Error('private credentials'), {
        code: 'EDNS',
        response: 'private SMTP response',
      }),
    );
    await expect(
      service.deliver({
        invitationId,
        version: 1,
      }),
    ).rejects.toThrow('Invitation email delivery failed');
    expect(application).toHaveBeenCalledWith({
      event: 'invitation.delivery_failed',
      invitationId,
      version: 1,
      stage: 'smtp-send',
      code: 'EDNS',
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private');
  });
  it('does not expose raw database errors when lookup and failure recording both fail', async () => {
    findUnique.mockRejectedValueOnce(
      new Error('sensitive database lookup failure'),
    );
    updateMany.mockRejectedValueOnce(
      new Error('sensitive database update failure'),
    );
    await expect(service.deliver({ invitationId, version: 1 })).rejects.toThrow(
      'Invitation email delivery failed',
    );
    expect(sendMail).not.toHaveBeenCalled();
  });
  it.each([
    { invitationId: '', version: 1 },
    { invitationId: 'invitation', version: 0 },
    { invitationId: 'invitation', version: NaN },
  ])('rejects malformed job %j before any database operation', async (job) => {
    await expect(service.deliver(job)).rejects.toThrow(
      'Invalid invitation delivery job',
    );
    expect(findUnique).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
  it.each([
    'revoked',
    'accepted',
    'expired',
    'old version',
    'already sent',
    'deleted org',
    'inactive org',
  ])('skips %s jobs', async (state) => {
    const invitation = row();
    if (state === 'revoked') invitation.status = 'REVOKED';
    if (state === 'accepted') invitation.status = 'ACCEPTED';
    if (state === 'expired') invitation.expiresAt = new Date(0);
    if (state === 'old version') invitation.deliveryVersion = 2;
    if (state === 'already sent') invitation.deliveryStatus = 'SENT';
    if (state === 'deleted org')
      Reflect.set(invitation.organization, 'deletedAt', new Date());
    if (state === 'inactive org') invitation.organization.isActive = false;
    findUnique.mockResolvedValue(invitation);
    await service.deliver({ invitationId, version: 1 });
    expect(sendMail).not.toHaveBeenCalled();
  });
  it('uses versioned job IDs without token payload and avoids overwriting SENT', async () => {
    Reflect.set(producer, 'queue', { add });
    add.mockResolvedValue({});
    expect(await producer.enqueue(invitationId, 2)).toBe(true);
    expect(add).toHaveBeenCalledWith(
      'send-invitation',
      { invitationId, version: 2 },
      expect.objectContaining({
        jobId: `${invitationId}-2`,
        attempts: 3,
        removeOnFail: { age: 604_800, count: 1_000 },
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: invitationId,
          deliveryVersion: 2,
          deliveryStatus: 'NOT_QUEUED',
        },
      }),
    );
  });
  it('preserves invitation when queue add fails', async () => {
    Reflect.set(producer, 'queue', { add });
    add.mockRejectedValueOnce(new Error('Redis unavailable'));
    expect(await producer.enqueue(invitationId, 1)).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
    expect(application).toHaveBeenCalledWith({
      event: 'invitation.enqueue_unavailable',
      invitationId,
      version: 1,
      stage: 'queue-acknowledgement',
      queue: INVITATION_EMAIL_QUEUE,
    });
  });

  it('reports queue connection errors with only the queue identifier', () => {
    expect(queueOn).toHaveBeenCalledWith('error', expect.any(Function));
    const onQueueError = queueOn.mock.calls.at(-1)?.[1] as () => void;
    onQueueError();
    expect(application).toHaveBeenCalledWith({
      event: 'invitation.queue_unavailable',
      queue: INVITATION_EMAIL_QUEUE,
    });
  });
});

describe('Nest email queue registration', () => {
  it('requires a registered queue rather than silently disabling email', async () => {
    await expect(
      Test.createTestingModule({
        providers: [
          InvitationEmailService,
          { provide: PrismaService, useValue: {} },
          { provide: LoggingService, useValue: logging },
        ],
      }).compile(),
    ).rejects.toThrow();
  });
  it('injects the registered queue into the producer', async () => {
    const queue = { on: vi.fn() };
    const module = await Test.createTestingModule({
      providers: [
        InvitationEmailService,
        { provide: PrismaService, useValue: {} },
        { provide: getQueueToken(INVITATION_EMAIL_QUEUE), useValue: queue },
        { provide: LoggingService, useValue: logging },
      ],
    }).compile();
    try {
      expect(module.get(InvitationEmailService)).toBeInstanceOf(
        InvitationEmailService,
      );
      expect(queue.on).toHaveBeenCalledWith('error', expect.any(Function));
    } finally {
      await module.close();
    }
  });
  it('dispatches invitation jobs through WorkerHost and rejects unsupported job names', async () => {
    const deliver = vi.fn(async () => {});
    const worker = new EmailNotificationWorker(
      { deliver } as unknown as InvitationDeliveryService,
      logging,
    );
    const data = {
      invitationId: '123e4567-e89b-42d3-a456-426614174000',
      version: 1,
    };
    await worker.process({
      name: EmailJobNames.SEND_INVITATION_EMAIL,
      data,
    } as Job<SendInvitationJobData>);
    expect(deliver).toHaveBeenCalledWith(data);
    await expect(
      worker.process({
        name: 'unsupported',
        data,
      } as Job<SendInvitationJobData>),
    ).rejects.toThrow('Unsupported email job');
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it('logs only allowlisted worker diagnostics and job references', () => {
    vi.clearAllMocks();
    const worker = new EmailNotificationWorker(
      {} as InvitationDeliveryService,
      logging,
    );
    const invitationId = '123e4567-e89b-42d3-a456-426614174000';
    worker.onError(
      Object.assign(new Error('private Redis diagnostic'), {
        code: 'ECONNRESET',
      }),
    );
    worker.onFailed({
      data: { invitationId, version: 2 },
      attemptsMade: 2,
      opts: { attempts: 3 },
    } as Job);
    worker.onCompleted({
      data: { invitationId, version: 2 },
    } as Job);

    expect(application).toHaveBeenNthCalledWith(1, {
      event: 'email.worker_error',
      queue: INVITATION_EMAIL_QUEUE,
      code: 'ECONNRESET',
    });
    expect(application).toHaveBeenNthCalledWith(2, {
      event: 'email.job_failed',
      queue: INVITATION_EMAIL_QUEUE,
      invitationId,
      version: 2,
      attempt: 2,
      maxAttempts: 3,
    });
    expect(application).toHaveBeenNthCalledWith(3, {
      event: 'email.job_completed',
      queue: INVITATION_EMAIL_QUEUE,
      invitationId,
      version: 2,
    });
    expect(JSON.stringify(application.mock.calls)).not.toContain('private');
  });
  it('can close safely if startup failed before processor registration', async () => {
    const worker = new EmailNotificationWorker(
      {} as InvitationDeliveryService,
      logging,
    );
    await expect(worker.onModuleDestroy()).resolves.toBeUndefined();
  });
});

describe('Always-on email configuration', () => {
  const valid = {
    DATABASE_URL: 'postgresql://fixture.invalid/test',
    JWT_ACCESS_TOKEN_SECRET: 'a'.repeat(64),
    JWT_REFRESH_TOKEN_SECRET: 'b'.repeat(64),
    S3_ENDPOINT: 'http://storage.invalid',
    S3_BUCKET: 'fixture',
    S3_ACCESS_KEY: 'fixture',
    S3_SECRET_KEY: 'fixture',
    S3_PUBLIC_URL: 'http://storage.invalid',
    FRONTEND_URL: 'http://frontend.invalid',
    INVITATION_TOKEN_SECRET: 'c'.repeat(64),
    REDIS_HOST: '127.0.0.1',
    SMTP_HOST: 'smtp.invalid',
    SMTP_FROM: 'fixture@example.com',
  };
  it('accepts required configuration with default ports and optional SMTP authentication', () => {
    const result = envValidationSchema.validate(valid);
    expect(result.error).toBeUndefined();
    expect(result.value).toMatchObject({ REDIS_PORT: 6379, SMTP_PORT: 587 });
  });
  it.each([
    'FRONTEND_URL',
    'INVITATION_TOKEN_SECRET',
    'REDIS_HOST',
    'SMTP_HOST',
    'SMTP_FROM',
  ])('requires %s on every startup', (field) => {
    const result = envValidationSchema.validate({ ...valid, [field]: '' });
    expect(result.error?.details[0].path).toEqual([field]);
  });
});
