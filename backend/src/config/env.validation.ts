import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  APP_NAME: Joi.string().default('Travel Planning Platform API'),
  PORT: Joi.number().port().default(3000),

  MONGODB_URI: Joi.string().uri().required(),

  CORS_ORIGINS: Joi.string().default('http://localhost:3001'),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  REFRESH_TOKEN_SECRET: Joi.string().min(32).required(),
  REFRESH_TOKEN_EXPIRES_IN: Joi.string().default('7d'),

  COOKIE_SECURE: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  COOKIE_DOMAIN: Joi.string().optional().allow(''),

  STRIPE_SECRET_KEY: Joi.string()
    .pattern(/^sk_test_/)
    .optional()
    .allow(''),
  STRIPE_WEBHOOK_SECRET: Joi.string()
    .pattern(/^whsec_/)
    .optional()
    .allow(''),
  STRIPE_CHECKOUT_SUCCESS_URL: Joi.string().uri().optional().allow(''),
  STRIPE_CHECKOUT_CANCEL_URL: Joi.string().uri().optional().allow(''),

  BOOKING_HOLD_MINUTES: Joi.number().integer().min(1).max(120).default(10),

  FXRATES_API_KEY: Joi.string().optional().allow(''),
  FXRATES_BASE_URL: Joi.string()
    .uri()
    .default('https://api.fxratesapi.com'),
  FXRATES_CACHE_TTL_MS: Joi.number().integer().min(1000).default(900000),
  FXRATES_STALE_TTL_MS: Joi.number().integer().min(1000).default(86400000),
  MEDIA_STORAGE_PATH: Joi.string().default('uploads/media'),
}).custom((value: {
  FXRATES_CACHE_TTL_MS: number;
  FXRATES_STALE_TTL_MS: number;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_CHECKOUT_SUCCESS_URL?: string;
  STRIPE_CHECKOUT_CANCEL_URL?: string;
}, helpers: Joi.CustomHelpers) => {
  if (
    value.FXRATES_STALE_TTL_MS < value.FXRATES_CACHE_TTL_MS
  ) {
    return helpers.error('any.invalid');
  }

  const stripeEnabled = Boolean(
    value.STRIPE_SECRET_KEY || value.STRIPE_WEBHOOK_SECRET,
  );
  if (
    stripeEnabled &&
    !(
      value.STRIPE_SECRET_KEY &&
      value.STRIPE_WEBHOOK_SECRET &&
      value.STRIPE_CHECKOUT_SUCCESS_URL &&
      value.STRIPE_CHECKOUT_CANCEL_URL
    )
  ) {
    return helpers.error('any.invalid');
  }

  return value;
}, 'FX rates cache window validation');
