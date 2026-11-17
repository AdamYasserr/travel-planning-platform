import { jest } from '@jest/globals';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { runBookingTransaction } from './booking-transaction';
import { BOOKING_HOLD_DURATION_MS, DEFAULT_BOOKING_HOLD_MINUTES, resolveHoldMinutes } from './booking-hold';

const writeConflict = () => Object.assign(new Error('WriteConflict'), { code: 112, errorLabels: ['TransientTransactionError'] });

function connection() {
  const sessions: any[] = [];
  return {
    sessions,
    startSession: async () => {
      const session = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(async () => undefined),
        abortTransaction: jest.fn(async () => undefined),
        inTransaction: () => true,
        endSession: jest.fn(async () => undefined),
      };
      sessions.push(session);
      return session;
    },
  };
}

describe('runBookingTransaction', () => {
  it('retries a write conflict and then succeeds', async () => {
    const conn = connection();
    const work = jest.fn<() => Promise<string>>().mockRejectedValueOnce(writeConflict()).mockResolvedValue('ok');
    await expect(runBookingTransaction(conn as never, work)).resolves.toBe('ok');
    expect(work).toHaveBeenCalledTimes(2);
    expect(conn.sessions[0].abortTransaction).toHaveBeenCalled();
    expect(conn.sessions[1].commitTransaction).toHaveBeenCalled();
  });

  it('returns 409 (not 500) when conflicts persist after the retry budget', async () => {
    const conn = connection();
    const work = jest.fn<() => Promise<string>>().mockRejectedValue(writeConflict());
    await expect(runBookingTransaction(conn as never, work, 3)).rejects.toBeInstanceOf(ConflictException);
    expect(work).toHaveBeenCalledTimes(3);
    expect(conn.sessions.every((s: any) => s.endSession.mock.calls.length === 1)).toBe(true);
  });

  it('does not retry business errors and aborts the transaction', async () => {
    const conn = connection();
    const work = jest.fn<() => Promise<string>>().mockRejectedValue(new BadRequestException('nope'));
    await expect(runBookingTransaction(conn as never, work)).rejects.toThrow('nope');
    expect(work).toHaveBeenCalledTimes(1);
    expect(conn.sessions[0].abortTransaction).toHaveBeenCalled();
    expect(conn.sessions[0].commitTransaction).not.toHaveBeenCalled();
  });
});

describe('booking hold duration (HTL-18, FLT-22)', () => {
  it('defaults to 10 minutes and can be overridden', () => {
    expect(DEFAULT_BOOKING_HOLD_MINUTES).toBe(10);
    expect(BOOKING_HOLD_DURATION_MS).toBe(10 * 60 * 1000);
    expect(resolveHoldMinutes('5')).toBe(5);
    expect(resolveHoldMinutes('garbage')).toBe(10);
    expect(resolveHoldMinutes('0')).toBe(10);
    expect(resolveHoldMinutes(undefined)).toBe(10);
  });
});
