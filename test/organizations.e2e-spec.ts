import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ORGANIZATIONS_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Organizations API (e2e)', () => {
  let app: INestApplication;
  const organizationPath = () => `/organizations/${randomUUID()}`;

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

  it('requires authentication to create an organization', async () => {
    await request(app.getHttpServer())
      .post('/organizations')
      .send({ name: 'Acme', slug: 'acme' })
      .expect(401);
  });

  it('requires authentication to list organizations', async () => {
    await request(app.getHttpServer()).get('/organizations').expect(401);
  });

  it('requires authentication to view an organization', async () => {
    await request(app.getHttpServer()).get(organizationPath()).expect(401);
  });

  it('requires authentication to rename an organization', async () => {
    await request(app.getHttpServer())
      .patch(organizationPath())
      .send({ name: 'Renamed' })
      .expect(401);
  });

  it('requires authentication to delete an organization', async () => {
    await request(app.getHttpServer()).delete(organizationPath()).expect(401);
  });

  it('requires authentication to view effective permissions', async () => {
    await request(app.getHttpServer())
      .get(`${organizationPath()}/me/permissions`)
      .expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .get('/organizations/not-a-uuid')
      .expect(401);
  });

  it('requires authentication before validating the request body', async () => {
    await request(app.getHttpServer())
      .post('/organizations')
      .send({ name: '', slug: 'Not A Slug' })
      .expect(401);
  });

  it('does not expose organization data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/organizations')
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
