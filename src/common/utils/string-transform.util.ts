import type { TransformFnParams } from 'class-transformer';

/**
 * These read the original request value instead of `value`: the global pipe
 * coerces types (enableImplicitConversion), which would turn an object into
 * "[object Object]" before validation. Non-strings pass through untouched so
 * `@IsString()` rejects them.
 */
function originalValue({ obj, key }: TransformFnParams): unknown {
  return (obj as Record<string, unknown>)[key];
}

/** Keeps the value exactly as sent so `@IsString()` can reject non-strings. */
export function keepAsSent(params: TransformFnParams): unknown {
  return originalValue(params);
}

export function trimText(params: TransformFnParams): unknown {
  const value = originalValue(params);
  return typeof value === 'string' ? value.trim() : value;
}

export function trimAndLowercase(params: TransformFnParams): unknown {
  const value = originalValue(params);
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}
