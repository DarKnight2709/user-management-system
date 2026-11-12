import type { TransformFnParams } from 'class-transformer';
import { describe, expect, it } from 'vitest';
import { trimAndLowercase, trimText } from './string-transform.util.js';

/** Mimics what the global pipe passes: `value` is already coerced to a string. */
function paramsFor(original: unknown): TransformFnParams {
  return {
    key: 'field',
    obj: { field: original },
    value: String(original),
  } as TransformFnParams;
}

describe('trimText', () => {
  it('trims surrounding whitespace', () => {
    expect(trimText(paramsFor('  Alice \n'))).toBe('Alice');
  });

  it('keeps inner whitespace and case', () => {
    expect(trimText(paramsFor(' Ann  Marie '))).toBe('Ann  Marie');
  });

  it.each([[12345], [{ a: 1 }], [null], [undefined]])(
    'returns the original non-string value %j instead of its coerced form',
    (original) => {
      expect(trimText(paramsFor(original))).toBe(original);
    },
  );
});

describe('trimAndLowercase', () => {
  it('trims and lowercases', () => {
    expect(trimAndLowercase(paramsFor('  Alice@Example.COM '))).toBe(
      'alice@example.com',
    );
  });

  it.each([[12345], [{ a: 1 }], [null], [undefined]])(
    'returns the original non-string value %j instead of its coerced form',
    (original) => {
      expect(trimAndLowercase(paramsFor(original))).toBe(original);
    },
  );
});
