import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_USERS_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Users API (e2e)', () => {
  let app: INestApplication;
  const userPath = () => `/users/${randomUUID()}`;

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

  it('requires authentication to list users', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
  });

  it('requires authentication to view a user', async () => {
    await request(app.getHttpServer()).get(userPath()).expect(401);
  });

  it('requires authentication to update the profile', async () => {
    await request(app.getHttpServer()).put('/users').send({}).expect(401);
  });

  it('requires authentication to delete a user', async () => {
    await request(app.getHttpServer()).delete(userPath()).expect(401);
  });

  it('requires authentication to upload an avatar', async () => {
    await request(app.getHttpServer()).post('/users/avatar').expect(401);
  });

  it('requires authentication before validating user IDs', async () => {
    await request(app.getHttpServer()).get('/users/not-a-uuid').expect(401);
  });

  it('does not expose user data without authentication', async () => {
    const response = await request(app.getHttpServer())
      .get('/users')
      .expect(401);

    expect(response.body.data).toBeUndefined();
  });
});
