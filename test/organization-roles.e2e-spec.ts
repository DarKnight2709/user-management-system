import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ORGANIZATION_ROLES_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Organization roles API (e2e)', () => {
  let app: INestApplication;
  const rolesPath = () => `/organizations/${randomUUID()}/roles`;

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

  it('requires authentication to list roles', async () => {
    await request(app.getHttpServer()).get(rolesPath()).expect(401);
  });

  it('requires authentication to view the grantable permissions', async () => {
    await request(app.getHttpServer())
      .get(`${rolesPath()}/permissions`)
      .expect(401);
  });

  it('requires authentication to create a role', async () => {
    await request(app.getHttpServer())
      .post(rolesPath())
      .send({ name: 'REVIEWER', permissionIds: [] })
      .expect(401);
  });

  it('requires authentication to update a role', async () => {
    await request(app.getHttpServer())
      .patch(`${rolesPath()}/${randomUUID()}`)
      .send({ name: 'REVIEWER' })
      .expect(401);
  });

  it('requires authentication to delete a role', async () => {
    await request(app.getHttpServer())
      .delete(`${rolesPath()}/${randomUUID()}`)
      .expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .get('/organizations/not-a-uuid/roles')
      .expect(401);
  });

  it('requires authentication before validating role IDs', async () => {
    await request(app.getHttpServer())
      .delete(`${rolesPath()}/not-a-uuid`)
      .expect(401);
  });

  it('requires authentication before validating the request body', async () => {
    await request(app.getHttpServer())
      .post(rolesPath())
      .send({ name: 'OWNER', permissionIds: ['not-a-uuid'] })
      .expect(401);
  });

  it('does not expose role data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get(rolesPath())
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
