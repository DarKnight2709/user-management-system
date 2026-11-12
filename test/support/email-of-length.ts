/**
 * Structurally valid address of the given total length (64-character local part
 * and labels of at most 63), so only its length decides whether it is accepted.
 */
export function emailOfLength(length: number): string {
  const localPart = 'a'.repeat(64);
  const fullLabel = 'b'.repeat(63);
  const lastLabelLength =
    length -
    localPart.length -
    '@'.length -
    2 * (fullLabel.length + '.'.length);
  return `${localPart}@${fullLabel}.${fullLabel}.${'c'.repeat(lastLabelLength)}`;
}
