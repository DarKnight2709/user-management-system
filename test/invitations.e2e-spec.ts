import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_INVITATION_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Invitation API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it('requires authentication for invitation management', async () => {
    await request(app.getHttpServer())
      .get(`/organizations/${randomUUID()}/invitations`)
      .expect(401);
  });

  it('requires authentication before validating invitation organization IDs', async () => {
    await request(app.getHttpServer())
      .get('/organizations/not-a-uuid/invitations')
      .expect(401);
  });

  it('requires authentication before validating acceptance tokens', async () => {
    await request(app.getHttpServer())
      .post('/invitations/accept')
      .send({ token: 'invalid' })
      .expect(401);
  });
});