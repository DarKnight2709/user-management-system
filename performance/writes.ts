// Write-path test: each iteration creates an organization (serializable
// transaction with owner membership and default roles), renames it and lists
// its members. Organizations accumulate in the throw-away database.
// Invitations are not covered: they enqueue emails and need SMTP.
import http from 'k6/http';
import { check, sleep } from 'k6';
import type { Options } from 'k6/options';
import {
  BASE_URL,
  authedParams,
  createUsers,
  patchJson,
  postJson,
} from './lib/common.ts';
import type { SetupData } from './lib/common.ts';

const USERS = Number(__ENV.USERS || 20);
// 4s between iterations keeps each route at ~15 requests/minute per user/IP.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 4);
const RUN_ID = String(Date.now());

export const options: Options = {
  setupTimeout: '600s',
  scenarios: {
    writes: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '20s', target: USERS },
        { duration: '1m30s', target: USERS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<1000'],
  },
};

// Logs unexpected statuses with the error body so failures can be diagnosed.
function report(
  label: string,
  r: { status: number; body: unknown },
  expected: number,
): void {
  if (r.status !== expected) {
    console.error(
      `${label} expected ${expected} got ${r.status}: ${String(r.body).slice(0, 300)}`,
    );
  }
}

export function setup(): SetupData {
  return createUsers(USERS);
}

export default function (data: SetupData): void {
  const index = (__VU - 1) % data.users.length;
  const user = data.users[index];

  const created = postJson(
    '/organizations',
    { name: `Perf ${__VU}-${__ITER}`, slug: `w-${RUN_ID}-${__VU}-${__ITER}` },
    index,
    user.token,
    'POST /organizations',
  );
  report('POST /organizations', created, 201);
  const created2xx = check(created, {
    'create organization is 201': (r) => r.status === 201,
  });
  if (!created2xx) {
    sleep(THINK_TIME_SECONDS);
    return;
  }
  const organizationId = String(created.json('data.id'));

  const renamed = patchJson(
    `/organizations/${organizationId}`,
    { name: `Perf renamed ${__VU}-${__ITER}` },
    index,
    user.token,
    'PATCH /organizations/:id',
  );
  report('PATCH /organizations/:id', renamed, 200);
  check(renamed, { 'rename organization is 200': (r) => r.status === 200 });

  const members = http.get(
    `${BASE_URL}/organizations/${organizationId}/members`,
    authedParams(index, user.token, 'GET /organizations/:id/members'),
  );
  report('GET /organizations/:id/members', members, 200);
  check(members, { 'member list is 200': (r) => r.status === 200 });

  sleep(THINK_TIME_SECONDS);
}
