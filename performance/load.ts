// Load test: sustained, realistic read traffic from many users, each with its
// own client IP. Use it to compare p95 and error rate between runs.
import { sleep } from 'k6';
import type { Options } from 'k6/options';
import { createUsers, readFlow } from './lib/common.ts';
import type { SetupData } from './lib/common.ts';

const USERS = Number(__ENV.USERS || 100);
// 4s between iterations keeps each route at ~15 requests/minute per user/IP.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 4);

export const options: Options = {
  setupTimeout: '600s',
  scenarios: {
    load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: USERS },
        { duration: '3m', target: USERS },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    http_req_duration: ['p(95)<500'],
  },
};

export function setup(): SetupData {
  return createUsers(USERS);
}

export default function (data: SetupData): void {
  const index = (__VU - 1) % data.users.length;
  readFlow(index, data.users[index]);
  sleep(THINK_TIME_SECONDS);
}
