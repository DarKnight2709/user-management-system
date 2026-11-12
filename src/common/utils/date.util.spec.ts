import { describe, expect, it } from 'vitest';
import { yearsAgo } from './date.util.js';

describe('yearsAgo', () => {
  const from = new Date('2026-06-15T12:00:00Z');

  it('subtracts whole years', () => {
    expect(yearsAgo(150, from).toISOString()).toBe('1876-06-15T12:00:00.000Z');
  });

  it('does not change the date it starts from', () => {
    yearsAgo(10, from);

    expect(from.toISOString()).toBe('2026-06-15T12:00:00.000Z');
  });

  it('returns the same instant for zero years', () => {
    expect(yearsAgo(0, from).getTime()).toBe(from.getTime());
  });

  it('defaults to the current time', () => {
    const before = Date.now();

    const result = yearsAgo(1).getTime();

    expect(result).toBeLessThan(before);
  });
});
