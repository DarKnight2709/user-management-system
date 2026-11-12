import { describe, expect, it } from 'vitest';
import {
  matchesCredentialRef,
  toCredentialRef,
} from '../utils/credential-ref.util.js';

const HASH = '$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
const OTHER_HASH =
  '$2b$10$zyxwvutsrqponmlkjihgfeZYXWVUTSRQPONMLKJIHGFEDCBA98765';

describe('toCredentialRef', () => {
  it('is deterministic for the same hash', () => {
    expect(toCredentialRef(HASH)).toBe(toCredentialRef(HASH));
  });

  it('differs for different hashes', () => {
    expect(toCredentialRef(HASH)).not.toBe(toCredentialRef(OTHER_HASH));
  });

  it('is a 64-character hex digest', () => {
    expect(toCredentialRef(HASH)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not contain the hash it was derived from', () => {
    expect(toCredentialRef(HASH)).not.toContain(HASH);
  });
});

describe('matchesCredentialRef', () => {
  it('accepts the reference of the same hash', () => {
    expect(matchesCredentialRef(HASH, toCredentialRef(HASH))).toBe(true);
  });

  it('rejects the reference of a different hash', () => {
    expect(matchesCredentialRef(HASH, toCredentialRef(OTHER_HASH))).toBe(false);
  });

  it.each([
    ['an empty reference', ''],
    ['a truncated reference', toCredentialRef(HASH).slice(0, 63)],
    ['an overlong reference', `${toCredentialRef(HASH)}0`],
  ])('rejects %s without throwing', (_, credentialRef) => {
    expect(matchesCredentialRef(HASH, credentialRef)).toBe(false);
  });
});
