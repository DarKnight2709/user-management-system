/* oxlint-disable unicorn/no-thenable -- Joi conditional schemas require a non-callable `then` property. */
import Joi from 'joi';

const jwtSecretSchema = Joi.string()
  .min(64)
  .pattern(/\s/, { invert: true })
  .messages({
    'string.pattern.invert.base': '{{#label}} must not contain whitespace',
  })
  .required();

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DATABASE_URL: Joi.string().required(),
  JWT_ACCESS_TOKEN_SECRET: jwtSecretSchema,
  JWT_REFRESH_TOKEN_SECRET: jwtSecretSchema
    .invalid(Joi.ref('JWT_ACCESS_TOKEN_SECRET'))
    .messages({
      'any.invalid':
        'JWT_REFRESH_TOKEN_SECRET must differ from JWT_ACCESS_TOKEN_SECRET',
    }),
  JWT_ACCESS_TOKEN_EXPIRES_IN: Joi.number().integer().positive().default(900),
  JWT_REFRESH_TOKEN_EXPIRES_IN: Joi.number()
    .integer()
    .positive()
    .default(604800),

  S3_ENDPOINT: Joi.string().uri().required(),
  S3_REGION: Joi.string().default('us-east-1'),
  S3_BUCKET: Joi.string().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
  S3_PUBLIC_URL: Joi.string().uri().required(),
  LOG_DATABASE_QUERIES: Joi.boolean().default(false),
  FRONTEND_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .empty('')
    .required(),
  INVITATION_TOKEN_SECRET: Joi.string()
    .min(64)
    .pattern(/\s/, { invert: true })
    .invalid(
      Joi.ref('JWT_ACCESS_TOKEN_SECRET'),
      Joi.ref('JWT_REFRESH_TOKEN_SECRET'),
    )
    .empty('')
    .required(),
  REDIS_HOST: Joi.string().empty('').required(),
  REDIS_PORT: Joi.number().port().empty('').default(6379),
  REDIS_PASSWORD: Joi.string().empty(''),
  REDIS_QUEUE_PREFIX: Joi.string()
    .pattern(/^[a-zA-Z0-9_-]+$/)
    .empty('')
    .default('ums'),
  SMTP_HOST: Joi.string().empty('').required(),
  SMTP_PORT: Joi.number().port().empty('').default(587),
  SMTP_SECURE: Joi.boolean().empty('').default(false),
  SMTP_FROM: Joi.string().email().empty('').required(),
  SMTP_USER: Joi.string().empty(''),
  SMTP_PASSWORD: Joi.string()
    .empty('')
    .when('SMTP_USER', { is: Joi.exist(), then: Joi.required() }),
}).with('SMTP_PASSWORD', 'SMTP_USER');
