import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * One-way reference to a stored password hash. Login carries it from
 * credential validation to session creation so a password changed in between
 * is detected without passing the hash itself around.
 */
export function toCredentialRef(hashedPassword: string): string {
  return createHash('sha256').update(hashedPassword).digest('hex');
}

export function matchesCredentialRef(
  hashedPassword: string,
  credentialRef: string,
): boolean {
  const expected = Buffer.from(toCredentialRef(hashedPassword));
  const actual = Buffer.from(credentialRef);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
