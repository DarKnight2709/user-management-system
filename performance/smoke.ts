import { sleep } from 'k6';
import type { Options } from 'k6/options';
import { createUsers, readFlow } from './lib/common.ts';
import type { SetupData } from './lib/common.ts';

const USERS = Number(__ENV.USERS || 10);
// 4s between iterations keeps each route at ~15 requests/minute per user/IP.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 4);

export const options: Options = {
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

export function setup(): SetupData {
  return createUsers(USERS);
}

export default function (data: SetupData): void {
  const index = (__VU - 1) % data.users.length;
  readFlow(index, data.users[index]);
  sleep(THINK_TIME_SECONDS);
}
