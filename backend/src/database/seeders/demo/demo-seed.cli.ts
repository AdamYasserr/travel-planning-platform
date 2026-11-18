import 'reflect-metadata';
import './seed-env';

import { createSeedApp } from './seed-app';
import { resetDemoData, SeedResetBlockedError, seedDemoData } from './demo-seed';
import { formatSummary } from './demo-seed.print';
import {
  assertMayWrite,
  describeDatabase,
  parseSeedArgs,
  resolveSeedPassword,
} from './demo-seed.options';
import { SEED_TAG } from './demo-seed.constants';

/**
 * npm run seed -- --yes              create the demo data (nothing new on a second run)
 * npm run seed -- --reset --yes      remove the documents of an earlier run, then create them again
 * Options: --yes (or SEED_CONFIRM=yes), --force (NODE_ENV=production), --reset. See docs/seed.md.
 */
async function main(): Promise<void> {
  const options = parseSeedArgs(process.argv.slice(2), process.env);
  const uri = process.env.MONGODB_URI?.trim();
  if (!uri) throw new Error('MONGODB_URI is required (set it in .env)');
  const password = resolveSeedPassword(process.env);
  const target = describeDatabase(uri);
  console.log(`Demo seed (${SEED_TAG}) will ${options.reset ? 'RESET and re-create' : 'create'} its data in database "${target.database}" on ${target.host}`);
  assertMayWrite(options, process.env);

  const app = await createSeedApp();
  try {
    if (options.reset) {
      try {
        const reset = await resetDemoData(app);
        console.log(`Reset: removed ${Object.values(reset.deleted).reduce((a, b) => a + b, 0)} documents of the earlier seed run`);
      } catch (error) {
        if (error instanceof SeedResetBlockedError) {
          console.error(error.message);
          process.exitCode = 1;
          return;
        }
        throw error;
      }
    }
    console.log(formatSummary(await seedDemoData(app, { password }), password));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('Demo seed failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
});
