import Joi from 'joi';
import type { ApplicationEventInput } from '../types/application-event.types.js';
import { securityRequestContextSchema } from './security-request-context.schema.js';

const requestContextSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
}).required();

const optionalRequestContextSchema = Joi.object({
  requestId: Joi.string().uuid().required(),
});

const databaseQueryFields = {
  queryFingerprint: Joi.string().hex().length(64).required(),
  durationMs: Joi.number().min(0).max(Number.MAX_SAFE_INTEGER).required(),
  requestContext: optionalRequestContextSchema,
};

const backgroundErrorCategorySchema = Joi.string().valid(
  'database',
  'timeout',
  'storage_authorization',
  'storage_bucket_missing',
  'storage_unavailable',
  'unknown',
);

const safeEmailErrorCodeSchema = Joi.string().valid(
  'EDNS',
  'EAUTH',
  'ETIMEDOUT',
  'ESOCKET',
  'ECONNECTION',
  'ETLS',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENODATA',
  'ETIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EENVELOPE',
  'EMESSAGE',
  'P1001',
  'P1002',
  'P1008',
  'P2024',
  'P2025',
  'P2034',
  'UNKNOWN',
);

const safeEmailErrorFields = {
  code: safeEmailErrorCodeSchema.required(),
  responseCode: Joi.number().integer().min(400).max(599),
};

const invitationStageSchema = Joi.string().valid(
  'database-read',
  'link-configuration',
  'smtp-send',
  'database-record-sent',
  'database-record-failed',
);

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
      event: Joi.string().valid('http.payload_invalid').required(),
      statusCode: Joi.number().valid(400).required(),
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
      event: Joi.string()
        .valid('database.info', 'database.warning', 'database.error')
        .required(),
      requestContext: optionalRequestContextSchema,
    }),
    Joi.object({
      ...databaseQueryFields,
      event: Joi.string().valid('database.query_completed').required(),
    }),
    Joi.object({
      ...databaseQueryFields,
      event: Joi.string().valid('database.slow_query').required(),
      thresholdMs: Joi.number()
        .integer()
        .min(1)
        .max(Number.MAX_SAFE_INTEGER)
        .required(),
    }),
    Joi.object({
      event: Joi.string().valid('avatar.cleanup_worker_failed').required(),
      errorCategory: backgroundErrorCategorySchema.required(),
    }),
    Joi.object({
      event: Joi.string()
        .valid('avatar.cleanup_retry_scheduling_failed')
        .required(),
      taskId: Joi.string().uuid().required(),
      attempt: Joi.number().integer().min(1).required(),
      errorCategory: backgroundErrorCategorySchema.required(),
      schedulingErrorCategory: backgroundErrorCategorySchema.required(),
    }),
    Joi.object({
      event: Joi.string().valid('avatar.cleanup_retry_scheduled').required(),
      taskId: Joi.string().uuid().required(),
      attempt: Joi.number().integer().min(1).required(),
      errorCategory: backgroundErrorCategorySchema.required(),
      retryDelayMs: Joi.number().integer().min(1).max(3_600_000).required(),
    }),
    Joi.object({
      event: Joi.string().valid('invitation.queue_unavailable').required(),
      queue: Joi.string().valid('invitation-email').required(),
    }),
    Joi.object({
      event: Joi.string().valid('invitation.enqueue_unavailable').required(),
      invitationId: Joi.string().uuid().required(),
      version: Joi.number().integer().min(1).required(),
      stage: Joi.string()
        .valid('queue-acknowledgement', 'database-mark-queued')
        .required(),
      queue: Joi.string().valid('invitation-email').required(),
    }),
    Joi.object({
      ...safeEmailErrorFields,
      event: Joi.string().valid('invitation.delivery_failed').required(),
      invitationId: Joi.string().uuid().required(),
      version: Joi.number().integer().min(1).required(),
      stage: invitationStageSchema.required(),
    }),
    Joi.object({
      ...safeEmailErrorFields,
      event: Joi.string().valid('invitation.failure_record_failed').required(),
      invitationId: Joi.string().uuid().required(),
      version: Joi.number().integer().min(1).required(),
      stage: Joi.string().valid('database-record-failed').required(),
    }),
    Joi.object({
      ...safeEmailErrorFields,
      event: Joi.string().valid('email.worker_error').required(),
      queue: Joi.string().valid('invitation-email').required(),
    }),
    Joi.object({
      event: Joi.string().valid('email.job_failed').required(),
      queue: Joi.string().valid('invitation-email').required(),
      invitationId: Joi.string().uuid(),
      version: Joi.number().integer().min(1),
      attempt: Joi.number().integer().min(1),
      maxAttempts: Joi.number().integer().min(1),
    })
      .and('invitationId', 'version')
      .and('attempt', 'maxAttempts'),
    Joi.object({
      event: Joi.string().valid('email.job_completed').required(),
      queue: Joi.string().valid('invitation-email').required(),
      invitationId: Joi.string().uuid().required(),
      version: Joi.number().integer().min(1).required(),
    }),
    Joi.object({
      event: Joi.string().valid('application.started').required(),
      port: Joi.number().integer().min(1).max(65_535).required(),
    }),
    Joi.object({
      event: Joi.string()
        .valid('application.shutdown_started', 'application.shutdown_failed')
        .required(),
      signal: Joi.string().valid('SIGINT', 'SIGTERM').required(),
    }),
    Joi.object({
      event: Joi.string().valid('auth.refresh_failed').required(),
      requestContext: securityRequestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('auth.logout_failed').required(),
      userId: Joi.string().uuid().required(),
      scope: Joi.string().valid('all_sessions').required(),
      requestContext: securityRequestContextSchema,
    }),
    Joi.object({
      event: Joi.string().valid('auth.logout_session_failed').required(),
      userId: Joi.string().uuid().required(),
      scope: Joi.string().valid('session_family').required(),
      requestContext: securityRequestContextSchema,
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
