// k6 smoke/regression script. Run it only against a throw-away instance
// (see .github/workflows/k6.yml): setup() registers users and organizations.
//
// Rate limits: the default `ip` policy allows 20 requests/minute per IP per
// route. The target must run with NODE_ENV=production (trust proxy = 1) behind
// no real proxy, so each virtual user can present its own IP through
// X-Forwarded-For and stay under the limit. Never use this against a shared
// environment.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const USERS = Number(__ENV.USERS || 10);
// 4s between iterations keeps each route at ~15 requests/minute per user/IP.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 4);
const PASSWORD = __ENV.TEST_USER_PASSWORD || 'k6-smoke-Password-0123456789';

export const options = {
  setupTimeout: '180s',
  scenarios: {
    smoke: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: USERS },
        { duration: '45s', target: USERS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
  },
  thresholds: {
    // 429 responses count as failures, so this also guards the rate-limit setup.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // Local baseline was p95 ~25ms; this leaves wide headroom for a shared CI
    // runner. Tighten it after a few baseline runs there.
    http_req_duration: ['p(95)<500'],
  },
};

function headersFor(index, token) {
  const headers = {
    'Content-Type': 'application/json',
    // TEST-NET-3 addresses (RFC 5737): one distinct client IP per user.
    'X-Forwarded-For': `203.0.113.${index + 1}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function post(path, body, index, token) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headersFor(index, token),
    tags: { name: `setup ${path}` },
  });
}

export function setup() {
  const runId = `${Date.now()}`;
  const users = [];
  for (let i = 0; i < USERS; i += 1) {
    const email = `k6-${runId}-${i}@example.com`;
    const registered = post(
      '/auth/register',
      {
        username: `k6${runId}${i}`,
        firstName: 'K6',
        lastName: `User${i}`,
        email,
        password: PASSWORD,
        birthDate: '1990-01-01',
      },
      i,
    );
    const login = post('/auth/login', { email, password: PASSWORD }, i);
    const token = login.json('data.accessToken');
    const me = http.get(`${BASE_URL}/auth/me`, {
      headers: headersFor(i, token),
    });
    const org = post(
      '/organizations',
      { name: `K6 Org ${i}`, slug: `k6-${runId}-${i}` },
      i,
      token,
    );
    const ok =
      registered.status < 300 &&
      login.status < 300 &&
      me.status === 200 &&
      org.status < 300;
    if (!ok) {
      throw new Error(
        `setup failed for user ${i}: register=${registered.status} login=${login.status} me=${me.status} org=${org.status}`,
      );
    }
    users.push({
      email,
      token,
      userId: me.json('data.id'),
      organizationId: org.json('data.id'),
    });
  }
  return { users };
}

export default function (data) {
  const index = (__VU - 1) % data.users.length;
  const user = data.users[index];
  const params = { headers: headersFor(index, user.token) };

  const health = http.get(`${BASE_URL}/health/ready`, {
    tags: { name: 'GET /health/ready' },
  });
  check(health, { 'health ready is 200': (r) => r.status === 200 });

  const self = http.get(`${BASE_URL}/users/${user.userId}`, {
    ...params,
    tags: { name: 'GET /users/:id' },
  });
  check(self, { 'own user is 200': (r) => r.status === 200 });

  const orgs = http.get(`${BASE_URL}/organizations`, {
    ...params,
    tags: { name: 'GET /organizations' },
  });
  check(orgs, {
    'organization list is 200': (r) => r.status === 200,
    'organization list contains the user org': (r) =>
      r.status === 200 && r.json('data.total') >= 1,
  });

  const members = http.get(
    `${BASE_URL}/organizations/${user.organizationId}/members`,
    { ...params, tags: { name: 'GET /organizations/:id/members' } },
  );
  check(members, { 'member list is 200': (r) => r.status === 200 });

  sleep(THINK_TIME_SECONDS);
}
