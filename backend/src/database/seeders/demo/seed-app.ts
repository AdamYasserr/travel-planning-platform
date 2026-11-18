import type { INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { AppModule } from '../../../app.module';

/**
 * The application's providers without an HTTP server and WITHOUT the start-up hooks, for the seed script.
 * That keeps two things off, so the seed writes nothing but its own documents: the cron jobs (they would also
 * expire, complete and refund the bookings of other people) and the hotel rating recount that runs on boot
 * (it rewrites the rating of every hotel). The module is compiled, never initialised.
 */
export async function createSeedApp(): Promise<INestApplicationContext> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  return moduleRef;
}
