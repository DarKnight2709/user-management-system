// Stress test: raises the number of concurrent users step by step to find
// where latency or errors start to climb. It has no thresholds on purpose: the
// goal is to read the numbers per step, not to pass or fail. Run it with the
// same CPU and memory limits as production for numbers that mean something.
import { sleep } from 'k6';
import type { Options } from 'k6/options';
import { createUsers, readFlow } from './lib/common.ts';
import type { SetupData } from './lib/common.ts';

const USERS = Number(__ENV.USERS || 400);
// 4s between iterations keeps each route at ~15 requests/minute per user/IP.
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || 4);

const step = (fraction: number): number =>
  Math.max(1, Math.round(USERS * fraction));

export const options: Options = {
  setupTimeout: '1800s',
  scenarios: {
    stress: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: step(0.125) },
        { duration: '1m', target: step(0.25) },
        { duration: '1m', target: step(0.5) },
        { duration: '1m', target: step(1) },
        { duration: '1m', target: step(1) },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
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
