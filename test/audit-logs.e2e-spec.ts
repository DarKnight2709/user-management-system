import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_AUDIT_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Audit logs API (e2e)', () => {
  let app: INestApplication;
  const organizationAuditPath = () =>
    `/organizations/${randomUUID()}/audit-logs`;

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

  it('requires authentication to list platform audit events', async () => {
    await request(app.getHttpServer()).get('/audit-logs').expect(401);
  });

  it('requires authentication to list organization audit events', async () => {
    await request(app.getHttpServer()).get(organizationAuditPath()).expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .get('/organizations/not-a-uuid/audit-logs')
      .expect(401);
  });

  it('requires authentication before validating the query', async () => {
    await request(app.getHttpServer())
      .get('/audit-logs?page=0&limit=1000&action=nope')
      .expect(401);
  });

  it('does not expose audit data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/audit-logs')
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
