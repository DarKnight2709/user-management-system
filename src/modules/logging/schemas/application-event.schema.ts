import Joi from 'joi';
import type { ApplicationEventInput } from '../types/application-event.types.js';

const requestContextSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
}).required();

const httpFields = {
  method: Joi.string()
    .custom((value: string) =>
      [
        'GET',
        'POST',
        'PUT',
        'PATCH',
        'DELETE',
        'HEAD',
        'OPTIONS',
        'CONNECT',
        'TRACE',
      ].includes(value)
        ? value
        : 'OTHER',
    )
    .required(),
  // Caller supplies only the registered route template, never the raw URL.
  route: Joi.string()
    .custom((value: string) => {
      // oxlint-disable-next-line no-control-regex -- Reject log control characters.
      return value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
        ? value
        : '[unmatched]';
    })
    .required(),
  durationMs: Joi.number()
    .integer()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .required(),
  requestContext: requestContextSchema,
};

export const applicationEventSchema = Joi.alternatives<ApplicationEventInput>()
  .try(
    Joi.object({
      ...httpFields,
      event: Joi.string().valid('http.request.completed').required(),
      statusCode: Joi.number().integer().min(100).max(599).required(),
      outcome: Joi.string().valid('completed').required(),
    }),
    Joi.object({
      ...httpFields,
      event: Joi.string().valid('http.request.aborted').required(),
      statusCode: Joi.valid(null).required(),
      outcome: Joi.string().valid('aborted').required(),
    }),
    Joi.object({
      event: Joi.string().valid('http.operational_error').required(),
      statusCode: Joi.number().integer().min(400).max(599).required(),
      requestContext: requestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('http.payload_too_large').required(),
      statusCode: Joi.number().valid(413).required(),
      requestContext: requestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('http.unhandled_error').required(),
      statusCode: Joi.number().valid(500).required(),
      errorType: Joi.string()
        .valid(
          'Error',
          'TypeError',
          'RangeError',
          'ReferenceError',
          'SyntaxError',
          'URIError',
          'EvalError',
          'AggregateError',
          'NonError',
        )
        .required(),
      stackFrames: Joi.array()
        .items(
          Joi.string()
            .pattern(/^\s*at /)
            .max(1024),
        )
        .max(32),
      requestContext: requestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('database.unhandled_error').required(),
      code: Joi.string()
        .pattern(/^P\d{4}$/)
        .required(),
      requestContext: requestContextSchema,
    }),
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
