import type { Config } from 'jest';

/**
 * Integration tests run against an in-memory MongoDB replica set (transactions need one).
 * They never touch Atlas. The first run downloads a mongod binary (cached afterwards).
 * Run with: npm run test:integration
 */
const config: Config = {
  preset: 'ts-jest/presets/default-esm',
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.integration\\.ts$',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          module: 'ESNext',
          moduleResolution: 'Bundler',
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
  testTimeout: 180_000,
  maxWorkers: 1,
};

export default config;
