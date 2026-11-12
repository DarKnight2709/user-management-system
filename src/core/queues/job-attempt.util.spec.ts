import type { Job } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { jobAttemptLogFields } from './job-attempt.util.js';

const jobWith = (attemptsMade: unknown, attempts: unknown) =>
  ({ attemptsMade, opts: { attempts } }) as unknown as Job;

describe('jobAttemptLogFields', () => {
  it('returns the attempt and the limit', () => {
    expect(jobAttemptLogFields(jobWith(2, 3))).toEqual({
      attempt: 2,
      maxAttempts: 3,
    });
  });

  it.each([
    ['no attempt made yet', 0, 3],
    ['a negative attempt', -1, 3],
    ['a fractional attempt', 1.5, 3],
    ['no limit', 1, undefined],
    ['a zero limit', 1, 0],
    ['a fractional limit', 1, 2.5],
    ['a limit that is not a number', 1, '3'],
  ])('returns nothing for %s', (_, attemptsMade, attempts) => {
    expect(jobAttemptLogFields(jobWith(attemptsMade, attempts))).toEqual({});
  });
});
