import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

const runE2eTests = process.env.RUN_ORGANIZATION_OWNERSHIP_E2E_TESTS === 'true';

describe.runIf(runE2eTests)('Organization ownership API (e2e)', () => {
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

  it('requires authentication for ownership transfer', async () => {
    await request(app.getHttpServer())
      .post(`/organizations/${randomUUID()}/transfer-ownership`)
      .send({ memberId: randomUUID() })
      .expect(401);
  });

  it('requires authentication before validating organization IDs', async () => {
    await request(app.getHttpServer())
      .post('/organizations/not-a-uuid/transfer-ownership')
      .send({ memberId: randomUUID() })
      .expect(401);
  });

  it('requires authentication before validating the target membership', async () => {
    await request(app.getHttpServer())
      .post(`/organizations/${randomUUID()}/transfer-ownership`)
      .send({ memberId: 'not-a-uuid' })
      .expect(401);
  });
});
