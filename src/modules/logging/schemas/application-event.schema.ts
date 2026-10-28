import Joi from 'joi';
import type { ApplicationEventInput } from '../types/application-event.types.js';

const requestContextSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
}).required();

export const applicationEventSchema = Joi.alternatives<ApplicationEventInput>()
  .try(
    Joi.object({
      event: Joi.string().valid('auth.refresh_failed').required(),
      requestContext: requestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('auth.logout_failed').required(),
      userId: Joi.string().uuid().required(),
      scope: Joi.string().valid('all_sessions').required(),
      requestContext: requestContextSchema,
    }),
  )
  .required()
  .prefs({
    convert: false,
    abortEarly: true,
    stripUnknown: { objects: true },
  });

export function parseApplicationEvent(input: unknown): ApplicationEventInput {
  const { error, value } = applicationEventSchema.validate(input);
  if (error) {
    // Validation details may contain secrets from rejected input.
    throw new Error('Invalid application event');
  }
  return value;
}
