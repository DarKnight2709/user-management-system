import Joi from 'joi';

export const envValidationSchema = Joi.object({
  PORT: Joi.number().default(3000),
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  DATABASE_URL: Joi.string().required(),
  JWT_ACCESS_TOKEN_SECRET: Joi.string().required(),
  JWT_REFRESH_TOKEN_SECRET: Joi.string()
    .invalid(Joi.ref('JWT_ACCESS_TOKEN_SECRET'))
    .required(),
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
});
