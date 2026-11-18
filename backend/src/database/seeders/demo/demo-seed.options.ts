/** Command line and environment rules of `npm run seed`. Pure functions, so they are unit tested. */

export const DEFAULT_SEED_PASSWORD = 'DemoPass123';

export interface SeedOptions {
  /** Remove the documents of an earlier seed run first, then create them again. */
  reset: boolean;
  /** The operator confirmed the database that will be written (--yes or SEED_CONFIRM=yes). */
  confirmed: boolean;
  /** Allow NODE_ENV=production. */
  force: boolean;
}

export interface SeedEnv {
  NODE_ENV?: string;
  SEED_CONFIRM?: string;
  SEED_PASSWORD?: string;
}

const KNOWN_FLAGS = new Set(['--reset', '--yes', '--force']);

/** Unknown flags are an error: a typo such as `--rest` must not run a normal seed silently. */
export function parseSeedArgs(argv: string[], env: SeedEnv = {}): SeedOptions {
  const unknown = argv.filter((arg) => !KNOWN_FLAGS.has(arg));
  if (unknown.length) {
    throw new Error(`Unknown option ${unknown.join(', ')}. Supported options: --reset, --yes, --force`);
  }
  return {
    reset: argv.includes('--reset'),
    confirmed: argv.includes('--yes') || env.SEED_CONFIRM === 'yes',
    force: argv.includes('--force'),
  };
}

/** Host and database name of a MongoDB URI. The user name and password are never part of the result. */
export function describeDatabase(uri: string): { host: string; database: string } {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)\/?([^?]*)/.exec(uri.trim());
  if (!match) throw new Error('MONGODB_URI is not a valid MongoDB connection string');
  return { host: match[1], database: decodeURIComponent(match[2]) || 'test' };
}

/** Throws unless the run may write: production needs --force, and every run needs the confirmation. */
export function assertMayWrite(options: SeedOptions, env: SeedEnv): void {
  if (env.NODE_ENV === 'production' && !options.force) {
    throw new Error('Refusing to seed: NODE_ENV is production. Pass --force only if you are sure.');
  }
  if (!options.confirmed) {
    throw new Error('Refusing to write without confirmation. Check the database above, then add --yes (or set SEED_CONFIRM=yes).');
  }
}

/** SEED_PASSWORD or the documented default. It must satisfy the registration password policy. */
export function resolveSeedPassword(env: SeedEnv): string {
  const password = env.SEED_PASSWORD?.trim() ? env.SEED_PASSWORD.trim() : DEFAULT_SEED_PASSWORD;
  if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password) || Buffer.byteLength(password) > 72) {
    throw new Error('SEED_PASSWORD must have at least 8 characters, one letter and one number (72 bytes at most)');
  }
  return password;
}
