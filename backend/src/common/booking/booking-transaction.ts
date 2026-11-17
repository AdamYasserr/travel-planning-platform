import { ConflictException } from '@nestjs/common';
import type { ClientSession, Connection } from 'mongoose';

export const MAX_TRANSACTION_ATTEMPTS = 5;

function isTransient(error: unknown): boolean {
  const e = error as { hasErrorLabel?: (l: string) => boolean; code?: number; codeName?: string; errorLabels?: string[] };
  return (
    e?.hasErrorLabel?.('TransientTransactionError') === true ||
    e?.errorLabels?.includes('TransientTransactionError') === true ||
    e?.code === 112 ||
    e?.codeName === 'WriteConflict'
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` in a MongoDB transaction with a bounded retry on write conflicts.
 * (We do not use session.withTransaction: it retries internally for up to 120 s.)
 * Business errors (e.g. 409 "room unavailable") propagate unchanged and abort the transaction.
 * If conflicts persist after `attempts` tries the caller gets 409, never a 500.
 */
export async function runBookingTransaction<T>(
  connection: Connection,
  work: (session: ClientSession) => Promise<T>,
  attempts = MAX_TRANSACTION_ATTEMPTS,
): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const session = await connection.startSession();
    try {
      session.startTransaction();
      const result = await work(session);
      await commitWithRetry(session);
      return result;
    } catch (error) {
      try {
        if (session.inTransaction()) await session.abortTransaction();
      } catch {
        /* the original error is more useful */
      }
      if (!isTransient(error)) throw error;
      if (attempt === attempts) {
        throw new ConflictException('The room is being reserved or changed by another request. Please retry shortly.');
      }
      await sleep(10 * attempt + Math.floor(Math.random() * 20));
    } finally {
      await session.endSession();
    }
  }
  /* istanbul ignore next */
  throw new ConflictException('Transaction did not complete');
}

async function commitWithRetry(session: ClientSession): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      const unknown = (error as { hasErrorLabel?: (l: string) => boolean })?.hasErrorLabel?.('UnknownTransactionCommitResult');
      if (!unknown || i >= 2) throw error;
    }
  }
}
