// Login test: many users log in repeatedly. Login compares the password with
// bcrypt (cost 10), which is CPU-bound, so this is where latency should climb
// first. Each user stays under the account limit (5 logins/minute per email).
import { check, sleep } from 'k6';
import type { Options } from 'k6/options';
import { PASSWORD, postJson, registerOnly } from './lib/common.ts';

const USERS = Number(__ENV.USERS || 200);
// 13s between logins keeps each email at ~4.6 logins/minute, under the limit of 5.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 13);

export const options: Options = {
  setupTimeout: '1800s',
  scenarios: {
    login: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: USERS },
        { duration: '2m', target: USERS },
        { duration: '20s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    'http_req_duration{name:POST /auth/login}': ['p(95)<1500'],
  },
};

export function setup(): { emails: string[] } {
  return registerOnly(USERS);
}

export default function (data: { emails: string[] }): void {
  const index = (__VU - 1) % data.emails.length;
  const response = postJson(
    '/auth/login',
    { email: data.emails[index], password: PASSWORD },
    index,
    undefined,
    'POST /auth/login',
  );
  check(response, {
    'login is 2xx': (r) => r.status >= 200 && r.status < 300,
    'login returns an access token': (r) =>
      r.status < 300 && typeof r.json('data.accessToken') === 'string',
  });
  sleep(THINK_TIME_SECONDS);
}
