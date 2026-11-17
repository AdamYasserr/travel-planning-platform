import type { Config } from 'jest';

/**
 * End-to-end tests: the REAL Nest app (AppModule, real guards, pipes, cookies) driven over HTTP with supertest,
 * against an in-memory MongoDB replica set. They never touch Atlas. Stripe and the FX API are faked in
 * test/e2e/helpers/fakes.ts. Run with: npm run test:e2e
 *
 * Runs as ESM like the unit tests (@nestjs/common is ESM-only). Every test file starts its own replica set + app, so files are independent. maxWorkers is 2 so that
 * several mongod processes do not start at once on a laptop.
 */
const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  rootDir: '.',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '.*\\.e2e\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'bundler',
          target: 'ES2023',
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          esModuleInterop: true,
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testEnvironment: 'node',
  testTimeout: 120_000,
  maxWorkers: 2,
};

export default config;
