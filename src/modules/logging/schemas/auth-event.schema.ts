import Joi from 'joi';
import type { AuthSecurityEventInput } from '../types/auth-event.types.js';
import { securityRequestContextSchema } from './security-request-context.schema.js';

const idSchema = Joi.string().uuid().required();

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
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.password.change_failed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        reasonCode: Joi.string().valid('INVALID_CURRENT_PASSWORD').required(),
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.login.succeeded').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        authMethod: Joi.string().valid('PASSWORD').required(),
        sessionRef: idSchema,
        requestContext: securityRequestContextSchema,
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
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.password.changed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        requestContext: securityRequestContextSchema,
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
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.logout.completed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('SESSION_FAMILY').required(),
        sessionRef: Joi.string().uuid(),
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.logout.completed').required(),
        actor: Joi.object({
          type: Joi.string().valid('USER').required(),
          id: idSchema,
        }).required(),
        scope: Joi.string().valid('ALL_SESSIONS').required(),
        requestContext: securityRequestContextSchema,
      }),
      Joi.object({
        action: Joi.string().valid('auth.login.throttled').required(),
        actor: Joi.object({
          type: Joi.string().valid('ANONYMOUS').required(),
        }).required(),
        limitPolicy: Joi.string().valid('IP', 'ACCOUNT').required(),
        requestContext: securityRequestContextSchema,
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
