import Joi from 'joi';
import { isIP } from 'node:net';

const idSchema = Joi.string().uuid().required();

export const securityRequestContextSchema = Joi.object({
  requestId: idSchema,
  // Optional client context must not invalidate an otherwise valid event.
  sourceIp: Joi.any().custom((value: unknown) =>
    typeof value === 'string' && value.length <= 64 && isIP(value) !== 0
      ? value
      : undefined,
  ),
  userAgent: Joi.any().custom((value: unknown) => {
    if (typeof value !== 'string') return undefined;
    const sanitized = value
      .slice(0, 512)
      // oxlint-disable-next-line no-control-regex -- Strip control characters from untrusted User-Agent values.
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim();
    return sanitized || undefined;
  }),
}).required();
