// Shared helpers for the k6 scripts. Run them only against a throw-away
// instance (see .github/workflows/k6.yml): setup registers users and
// organizations.
//
// Rate limits: the default `ip` policy allows 20 requests/minute per IP per
// route (login also has 5/minute per email). The target must run with
// NODE_ENV=production (trust proxy = 1) behind no real proxy, so each virtual
// user can present its own IP through X-Forwarded-For and stay under the
// limits. Never use this against a shared environment.
import http from 'k6/http';
import type { Params, RefinedResponse, ResponseType } from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const PASSWORD =
  __ENV.TEST_USER_PASSWORD || 'k6-perf-Password-0123456789';

export interface TestUser {
  email: string;
  token: string;
  userId: string;
  organizationId: string;
}

export interface SetupData {
  users: TestUser[];
}

type Response = RefinedResponse<ResponseType | undefined>;

// One distinct private address per user index, so no user shares a
// rate-limit bucket with another.
export function ipFor(index: number): string {
  const n = index + 1;
  return `10.${Math.floor(n / 65536) % 256}.${Math.floor(n / 256) % 256}.${n % 256}`;
}

export function headersFor(
  index: number,
  token?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Forwarded-For': ipFor(index),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

export function authedParams(
  index: number,
  token: string,
  name: string,
): Params {
  return { headers: headersFor(index, token), tags: { name } };
}

export function postJson(
  path: string,
  body: unknown,
  index: number,
  token: string | undefined,
  name: string,
): Response {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headersFor(index, token),
    tags: { name },
  });
}

export function patchJson(
  path: string,
  body: unknown,
  index: number,
  token: string,
  name: string,
): Response {
  return http.patch(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headersFor(index, token),
    tags: { name },
  });
}

export function emailFor(index: number, runId: string): string {
  return `k6-${runId}-${index}@example.com`;
}

export function registerUser(index: number, runId: string): Response {
  return postJson(
    '/auth/register',
    {
      username: `k6${runId}${index}`,
      firstName: 'K6',
      lastName: `User${index}`,
      email: emailFor(index, runId),
      password: PASSWORD,
      birthDate: '1990-01-01',
    },
    index,
    undefined,
    'setup POST /auth/register',
  );
}

// Registers `count` users, logs each in once and gives each its own
// organization. Throws if any step fails so a broken setup never produces
// misleading performance numbers.
export function createUsers(count: number): SetupData {
  const runId = `${Date.now()}`;
  const users: TestUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const email = emailFor(i, runId);
    const registered = registerUser(i, runId);
    const login = postJson(
      '/auth/login',
      { email, password: PASSWORD },
      i,
      undefined,
      'setup POST /auth/login',
    );
    const token = String(login.json('data.accessToken'));
    const me = http.get(
      `${BASE_URL}/auth/me`,
      authedParams(i, token, 'setup GET /auth/me'),
    );
    const org = postJson(
      '/organizations',
      { name: `K6 Org ${i}`, slug: `k6-${runId}-${i}` },
      i,
      token,
      'setup POST /organizations',
    );
    if (
      registered.status >= 300 ||
      login.status >= 300 ||
      me.status !== 200 ||
      org.status >= 300
    ) {
      throw new Error(
        `setup failed for user ${i}: register=${registered.status} login=${login.status} me=${me.status} org=${org.status}`,
      );
    }
    users.push({
      email,
      token,
      userId: String(me.json('data.id')),
      organizationId: String(org.json('data.id')),
    });
  }
  return { users };
}

// Registers users without logging in; the login test does the logging in.
export function registerOnly(count: number): { emails: string[] } {
  const runId = `${Date.now()}`;
  const emails: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const registered = registerUser(i, runId);
    if (registered.status >= 300) {
      throw new Error(
        `setup failed for user ${i}: register=${registered.status}`,
      );
    }
    emails.push(emailFor(i, runId));
  }
  return { emails };
}

// The read-only user journey shared by smoke, load and stress.
export function readFlow(index: number, user: TestUser): void {
  const health = http.get(`${BASE_URL}/health/ready`, {
    tags: { name: 'GET /health/ready' },
  });
  check(health, { 'health ready is 200': (r) => r.status === 200 });

  const self = http.get(
    `${BASE_URL}/users/${user.userId}`,
    authedParams(index, user.token, 'GET /users/:id'),
  );
  check(self, { 'own user is 200': (r) => r.status === 200 });

  const orgs = http.get(
    `${BASE_URL}/organizations`,
    authedParams(index, user.token, 'GET /organizations'),
  );
  check(orgs, {
    'organization list is 200': (r) => r.status === 200,
    'organization list contains the user org': (r) =>
      r.status === 200 && Number(r.json('data.total')) >= 1,
  });

  const members = http.get(
    `${BASE_URL}/organizations/${user.organizationId}/members`,
    authedParams(index, user.token, 'GET /organizations/:id/members'),
  );
  check(members, { 'member list is 200': (r) => r.status === 200 });
}
