const sensitiveKey =
  /password|passwd|secret|token|authorization|cookie|credential|api[-_]?key/i;

export function redactLog(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  if (depth >= 8) {
    return '[MAX_DEPTH]';
  }

  if (seen.has(value)) {
    return '[CIRCULAR]';
  }

  if (Buffer.isBuffer(value)) return '[BUFFER_OMITTED]';
  if (value instanceof Error) return '[ERROR_OMITTED]';
  if (value instanceof Date) return value;

  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactLog(item, seen, depth + 1));
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key)
          ? '[REDACTED]'
          : redactLog(item, seen, depth + 1),
      ]),
    );
  } finally {
    seen.delete(value);
  }
}
