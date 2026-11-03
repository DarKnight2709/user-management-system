import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ADMIN_ORGANIZATION_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Admin organizations API (e2e)', () => {
  let app: INestApplication;

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

  it('requires authentication for organization administration', async () => {
    await request(app.getHttpServer())
      .get('/admin/organizations')
      .expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .patch('/admin/organizations/not-a-uuid/status')
      .send({ status: 'SUSPENDED' })
      .expect(401);
  });

  it('requires authentication before validating status bodies', async () => {
    await request(app.getHttpServer())
      .patch(`/admin/organizations/${randomUUID()}/status`)
      .send({ status: 'INVALID' })
      .expect(401);
  });

  it('does not expose organization data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/admin/organizations?page=1&limit=20')
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
