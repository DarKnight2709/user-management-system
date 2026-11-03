import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ORGANIZATION_MEMBERS_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Organization members API (e2e)', () => {
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

  it('requires authentication for member directory access', async () => {
    await request(app.getHttpServer())
      .get(`/organizations/${randomUUID()}/members`)
      .expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .get('/organizations/not-a-uuid/members')
      .expect(401);
  });

  it('requires authentication before validating member IDs', async () => {
    await request(app.getHttpServer())
      .delete(`/organizations/${randomUUID()}/members/not-a-uuid`)
      .expect(401);
  });

  it('requires authentication for role assignment and leaving', async () => {
    const organizationId = randomUUID();
    const memberId = randomUUID();
    const roleId = randomUUID();

    await request(app.getHttpServer())
      .put(
        `/organizations/${organizationId}/members/${memberId}/roles/${roleId}`,
      )
      .expect(401);
    await request(app.getHttpServer())
      .post(`/organizations/${organizationId}/members/leave`)
      .expect(401);
  });

  it('does not expose member data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get(`/organizations/${randomUUID()}/members?page=1&limit=20`)
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
