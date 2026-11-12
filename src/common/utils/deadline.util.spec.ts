import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from './deadline.util.js';

describe('withDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the value when the promise settles in time', async () => {
    await expect(
      withDeadline(Promise.resolve('done'), 100, 'late'),
    ).resolves.toBe('done');
  });

  it('passes on the promise failure', async () => {
    await expect(
      withDeadline(Promise.reject(new Error('failed')), 100, 'late'),
    ).rejects.toThrow('failed');
  });

  it('fails with the message once the limit passes', async () => {
    const result = withDeadline(new Promise(() => undefined), 100, 'too late');
    const assertion = expect(result).rejects.toThrow('too late');

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });

  it('keeps waiting until the limit', async () => {
    let settled = false;
    void withDeadline(new Promise(() => undefined), 100, 'late').catch(
      () => (settled = true),
    );

    await vi.advanceTimersByTimeAsync(99);

    expect(settled).toBe(false);
  });

  it('leaves no timer behind after the promise settles', async () => {
    await withDeadline(Promise.resolve('done'), 100, 'late');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind after the promise fails', async () => {
    await withDeadline(Promise.reject(new Error('failed')), 100, 'late').catch(
      () => undefined,
    );

    expect(vi.getTimerCount()).toBe(0);
  });
});
