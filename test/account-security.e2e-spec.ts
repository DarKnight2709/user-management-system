import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ACCOUNT_SECURITY_E2E_TESTS === 'true';

const VALID_TOKEN = 'A'.repeat(43);
const VALID_PASSWORD = 'a-brand-new-password';

async function startApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication();
  await app.init();
  return app;
}

// Only requests that never create an application record: an unknown address,
// malformed bodies and tokens that were never issued.
describe.runIf(runE2eTests)('Account security API (e2e)', () => {
  // Each suite starts its own app: the throttling counters live in memory.
  describe('forgot password', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await startApp();
    }, 30_000);

    afterAll(async () => {
      await app?.close();
    });

    const forgot = (body: unknown) =>
      request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send(body as object);

    it('answers 202 for an address without an account', async () => {
      const response = await forgot({
        email: `nobody-${randomUUID()}@example.invalid`,
      });

      expect(response.status).toBe(202);
    });

    it('does not say whether the address has an account', async () => {
      const response = await forgot({
        email: `nobody-${randomUUID()}@example.invalid`,
      });

      expect(JSON.stringify(response.body)).toContain(
        'If the email belongs to an account',
      );
    });

    it('rejects a malformed address with 422', async () => {
      await forgot({ email: 'not-an-email' }).expect(422);
    });

    it('rejects an address that is not a string with 422', async () => {
      await forgot({ email: { $ne: '' } }).expect(422);
    });

    it('rejects unexpected fields with 422', async () => {
      await forgot({ email: 'someone@example.invalid', admin: true }).expect(
        422,
      );
    });
  });

  describe('forgot password rate limit', () => {
    let app: INestApplication;
    let responses: request.Response[];

    // One address asked four times: the per-address limit is three per hour.
    beforeAll(async () => {
      app = await startApp();
      const email = `limited-${randomUUID()}@example.invalid`;
      responses = [];
      for (let attempt = 0; attempt < 4; attempt++) {
        responses.push(
          await request(app.getHttpServer())
            .post('/auth/forgot-password')
            .send({ email }),
        );
      }
    }, 30_000);

    afterAll(async () => {
      await app?.close();
    });

    it('allows three requests per address, then answers 429', () => {
      expect(responses.map(({ status }) => status)).toEqual([
        202, 202, 202, 429,
      ]);
    });

    it('tells the client when to retry', () => {
      expect(responses[3].headers['retry-after']).toBeDefined();
    });
  });

  describe('reset password', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await startApp();
    }, 30_000);

    afterAll(async () => {
      await app?.close();
    });

    const reset = (body: unknown) =>
      request(app.getHttpServer())
        .post('/auth/reset-password')
        .send(body as object);

    it('refuses a well-formed token that was never issued with 400', async () => {
      const response = await reset({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
      });

      expect(response.status).toBe(400);
    });

    it('gives the same generic message for an unknown token', async () => {
      const response = await reset({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
      });

      expect(response.body.message).toBe('Invalid or expired token');
    });

    it('rejects a malformed token with 422', async () => {
      await reset({ token: 'short', newPassword: VALID_PASSWORD }).expect(422);
    });

    it('rejects a weak new password with 422', async () => {
      await reset({ token: VALID_TOKEN, newPassword: 'short' }).expect(422);
    });

    it('rejects unexpected fields with 422', async () => {
      await reset({
        token: VALID_TOKEN,
        newPassword: VALID_PASSWORD,
        userId: randomUUID(),
      }).expect(422);
    });
  });
});
