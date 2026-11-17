import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getConnectionToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import request from 'supertest';

import { FxFake, StripeFake } from './fakes';

export type Agent = ReturnType<typeof request.agent>;

export interface E2EContext {
  app: INestApplication;
  /** Underlying http server, for supertest. */
  server: ReturnType<INestApplication['getHttpServer']>;
  conn: Connection;
  stripe: StripeFake;
  fx: FxFake;
  /** A fresh cookie jar, like a new browser tab / Swagger session. */
  agent(): Agent;
  /** Anonymous (no cookie) request helper. */
  http(): ReturnType<typeof request>;
  /** Resolve any provider of the real app, for calling jobs directly (e.g. the expiry cron method). */
  get<T>(token: new (...args: never[]) => T): T;
  /** Swagger JSON; only present when startApp({ swagger: true }). */
  swaggerDocument?: { paths: Record<string, Record<string, unknown>> };
  close(): Promise<void>;
}

export interface StartOptions {
  cookieSecure?: boolean;
  swagger?: boolean;
  /** NODE_ENV of the app under test (default 'test'). */
  nodeEnv?: 'test' | 'production';
}

/**
 * Boots the REAL AppModule against an in-memory replica set, with the same setup as main.ts
 * (configureApp: prefix, helmet, cookie parser, CORS, ValidationPipe). Only Stripe, FX rates and the
 * rate limiter are replaced. Env must be set BEFORE AppModule is imported (ConfigModule reads it on import),
 * which is why AppModule is imported dynamically here.
 */
export async function startApp(options: StartOptions = {}): Promise<E2EContext> {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri('e2e');
  Object.assign(process.env, {
    NODE_ENV: options.nodeEnv ?? 'test',
    MONGODB_URI: uri,
    JWT_SECRET: 'e2e-jwt-secret-'.padEnd(40, 'x'),
    REFRESH_TOKEN_SECRET: 'e2e-refresh-secret-'.padEnd(40, 'y'),
    COOKIE_SECURE: String(options.cookieSecure ?? false),
    BOOKING_HOLD_MINUTES: '10',
    // Stripe itself is replaced by StripeFake; these only make the app believe it runs against Stripe TEST mode.
    STRIPE_SECRET_KEY: 'sk_test_e2e_fake',
    STRIPE_WEBHOOK_SECRET: 'whsec_e2e_fake',
    // PAY-04: the e2e fixtures price rooms and cabins in EGP.
    PLATFORM_CURRENCY: 'EGP',
    FXRATES_API_KEY: '',
  });

  const { AppModule } = await import('../../../src/app.module');
  const { StripeService } = await import('../../../src/integrations/stripe/stripe.service');
  const { FxRatesService } = await import('../../../src/integrations/fx-rates/fx-rates.service');
  const { ThrottlerStorage } = await import('@nestjs/throttler');
  const { APP_OPTIONS, configureApp, configureSwagger } = await import('../../../src/app.setup');

  const stripe = new StripeFake();
  const fx = new FxFake();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(StripeService).useValue(stripe)
    .overrideProvider(FxRatesService).useValue(fx)
    // The real ThrottlerGuard still runs; its counter just never fills (100 req/min would break lockout/concurrency tests).
    .overrideProvider(ThrottlerStorage).useValue({ increment: async () => ({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }) })
    .compile();

  const app = moduleRef.createNestApplication({ ...APP_OPTIONS });
  configureApp(app);
  const swaggerDocument = options.swagger ? (configureSwagger(app) as unknown as E2EContext['swaggerDocument']) : undefined;
  await app.init();

  // Safety net: the app must be talking to the in-memory database, never Atlas.
  const configured = app.get(ConfigService).get<string>('database.uri');
  if (configured !== uri || !/^mongodb:\/\/127\.0\.0\.1/.test(uri)) {
    await app.close();
    await replSet.stop();
    throw new Error('e2e refused to start: the app is not using the in-memory MongoDB');
  }

  const server = app.getHttpServer();
  return {
    app,
    server,
    conn: app.get<Connection>(getConnectionToken()),
    stripe,
    fx,
    swaggerDocument,
    agent: () => request.agent(server),
    http: () => request(server),
    get: (token) => app.get(token as never),
    async close() {
      await app.close();
      await replSet.stop();
    },
  };
}

/** Wipe every collection (indexes stay). For tests that need an empty database. */
export async function resetDatabase(ctx: E2EContext): Promise<void> {
  const collections = await ctx.conn.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
}
