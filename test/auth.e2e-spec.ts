import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_AUTH_E2E_TESTS === 'true';

// Only requests that never reach a successful write: no application records are created.
describe.runIf(runE2eTests)('Auth API (e2e)', () => {
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

  it.each([
    ['get', '/auth/me'],
    ['post', '/auth/logout'],
    ['post', '/auth/logout-all'],
    ['post', '/auth/change-password'],
  ] as const)('requires authentication for %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).send({}).expect(401);
  });

  it('rejects a malformed bearer token', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
  });

  it('rejects an access token signed with an unknown secret', async () => {
    const forged =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4In0.' + 'c2lnbmF0dXJl';

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${forged}`)
      .expect(401);
  });

  it('rejects login with an unknown account without revealing why', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody@example.invalid', password: 'wrong-password-123' })
      .expect(401);

    expect(JSON.stringify(response.body)).not.toMatch(/not found|no user/i);
  });

  it('rejects login bodies missing credentials with a validation error', async () => {
    await request(app.getHttpServer()).post('/auth/login').send({}).expect(422);
  });

  it.each([
    ['a numeric email', { email: 12345, password: 'wrong-password-123' }],
    ['an object email', { email: { $ne: '' }, password: 'wrong-password-123' }],
    ['a numeric password', { email: 'nobody@example.invalid', password: 1 }],
  ])('rejects %s instead of failing with a server error', async (_, body) => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send(body)
      .expect(422);
  });

  it('rejects an invalid registration body before creating anything', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: 'not-an-email', password: 'short' });

    expect(response.status).toBe(422);
  });

  it('applies the shared profile rules to registration', async () => {
    // Both fields are invalid, so no account can be created even if a rule regresses.
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        username: 'alice',
        firstName: '   ',
        lastName: 'Doe',
        email: 'alice@example.com',
        birthDate: '2999-01-01',
        password: 'correct-password-123',
      })
      .expect(422);

    const invalidFields = (response.body.errors as { field: string }[]).map(
      ({ field }) => field,
    );
    expect(invalidFields).toEqual(
      expect.arrayContaining(['firstName', 'birthDate']),
    );
  });

  it('rejects a refresh with a malformed token', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh-token')
      .send({ refreshToken: 'not-a-jwt' });

    expect([401, 422]).toContain(response.status);
  });

  it('rejects a refresh with a well-formed but unknown token', async () => {
    const unsigned =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwianRpIjoieSJ9.' +
      'c2lnbmF0dXJl';

    await request(app.getHttpServer())
      .post('/auth/refresh-token')
      .send({ refreshToken: unsigned })
      .expect(401);
  });
});
