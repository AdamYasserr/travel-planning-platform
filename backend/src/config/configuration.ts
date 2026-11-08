export default () => ({
  app: {
    name: process.env.APP_NAME || 'Travel Planning Platform API',
    environment: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT || 3000),
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3001')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },
  database: {
    uri: process.env.MONGODB_URI,
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshTokenSecret: process.env.REFRESH_TOKEN_SECRET,
    refreshTokenExpiresIn: process.env.REFRESH_TOKEN_EXPIRES_IN || '7d',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
  },
  fxRates: {
    apiKey: process.env.FXRATES_API_KEY,
    baseUrl: process.env.FXRATES_BASE_URL || 'https://api.fxratesapi.com',
    cacheTtlMs: Number(process.env.FXRATES_CACHE_TTL_MS || 15 * 60 * 1000),
    staleTtlMs: Number(process.env.FXRATES_STALE_TTL_MS || 24 * 60 * 60 * 1000),
  },
  media: {
    storagePath: process.env.MEDIA_STORAGE_PATH || 'uploads/media',
  },
});