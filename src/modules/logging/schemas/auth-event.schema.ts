import Joi from 'joi';
import { isIP } from 'node:net';
import type { AuthSecurityEventInput } from '../types/auth-event.types.js';

const idSchema = Joi.string().uuid().required();

export const authRequestContextSchema = Joi.object({
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

export const authSecurityEventSchema =
  Joi.alternatives<AuthSecurityEventInput>()
    .try(
      Joi.object({
        action: Joi.string().valid('auth.registration.succeeded').required(),
        actor: Joi.object({
          type: Joi.string().valid('ANONYMOUS').required(),
        }).required(),
        target: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.password.change_failed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        reasonCode: Joi.string().valid('INVALID_CURRENT_PASSWORD').required(),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.login.succeeded').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        authMethod: Joi.string().valid('PASSWORD').required(),
        sessionRef: idSchema,
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.login.failed').required(),
        actor: Joi.object({
          type: Joi.string().valid('ANONYMOUS').required(),
        }).required(),
        authMethod: Joi.string().valid('PASSWORD').required(),
        reasonCode: Joi.string()
          .valid('INVALID_CREDENTIALS', 'ACCOUNT_UNAVAILABLE')
          .required(),
        // Only a pseudonymous SHA-256/HMAC reference; never the raw email.
        loginIdentifierRef: Joi.string().hex().length(64),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.password.changed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string()
          .valid('auth.refresh_token.reuse_detected')
          .required(),
        actor: Joi.object({
          type: Joi.string().valid('ANONYMOUS').required(),
        }).required(),
        target: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        sessionRef: idSchema,
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.logout.completed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('SESSION_FAMILY').required(),
        sessionRef: Joi.string().uuid(),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.logout.completed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('ALL_SESSIONS').required(),
        requestContext: authRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.login.throttled').required(),
        actor: Joi.object({
          type: Joi.string().valid('ANONYMOUS').required(),
        }).required(),
        limitPolicy: Joi.string().valid('IP', 'ACCOUNT').required(),
        requestContext: authRequestContextSchema,
      }),
    )
    .required()
    .prefs({
      convert: false,
      abortEarly: true,
      stripUnknown: { objects: true },
    });

export function parseAuthSecurityEvent(input: unknown): AuthSecurityEventInput {
  const { error, value } = authSecurityEventSchema.validate(input);
  if (error) {
    // Joi errors can contain input values; do not forward them to logs.
    throw new Error('Invalid authentication event');
  }
  return value;
}
