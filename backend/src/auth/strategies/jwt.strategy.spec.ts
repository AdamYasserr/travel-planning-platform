import { jest } from '@jest/globals';
import { UnauthorizedException } from '@nestjs/common';
import { Types } from 'mongoose';
import { JwtStrategy } from './jwt.strategy';
import { IDLE_TIMEOUT_MS } from '../auth.constants';

describe('JwtStrategy idle timeout (ACC-06)', () => {
  const id = new Types.ObjectId();
  let user: Record<string, any>;
  let model: { findById: jest.Mock; updateOne: jest.Mock };
  let strategy: JwtStrategy;
  const payload = () => ({ sub: id.toString(), email: 'a@example.com', role: 'user' });

  beforeEach(() => {
    user = { _id: id, email: 'a@example.com', role: 'user', isActive: true, isSuspended: false, deactivatedAt: null, mustChangePassword: false, lastActivityAt: new Date(), refreshTokenHash: 'hash' };
    model = {
      findById: jest.fn(async () => user) as never,
      updateOne: jest.fn(async (_f: unknown, update: any) => {
        Object.assign(user, update.$set);
        return {};
      }) as never,
    };
    strategy = new JwtStrategy({ getOrThrow: () => 'j'.repeat(40) } as never, model as never);
  });

  it('accepts a session active within the last 30 minutes and extends the window', async () => {
    const stamp = new Date(Date.now() - (IDLE_TIMEOUT_MS - 60_000));
    user.lastActivityAt = stamp;
    const result = await strategy.validate(payload());
    expect(result).toMatchObject({ userId: id.toString(), role: 'user', mustChangePassword: false });
    expect(user.lastActivityAt.getTime()).toBeGreaterThan(stamp.getTime());
  });

  it('each authenticated request resets the idle clock to now', async () => {
    user.lastActivityAt = new Date(Date.now() - 29 * 60_000);
    await strategy.validate(payload());
    expect(Date.now() - user.lastActivityAt.getTime()).toBeLessThan(2000);
  });

  it('expires the session after 30 idle minutes and revokes the refresh token', async () => {
    user.lastActivityAt = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000);
    await expect(strategy.validate(payload())).rejects.toThrow(/inactivity/);
    expect(user.refreshTokenHash).toBeNull();
  });

  it('does not extend activity when the session is already expired', async () => {
    const stale = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000);
    user.lastActivityAt = stale;
    await strategy.validate(payload()).catch(() => undefined);
    expect(user.lastActivityAt).toBe(stale);
  });

  it.each([
    ['suspended', { isSuspended: true }],
    ['deactivated', { isActive: false, deactivatedAt: new Date() }],
  ])('rejects a %s account', async (_label, patch) => {
    Object.assign(user, patch);
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose user no longer exists', async () => {
    model.findById.mockResolvedValue(null as never);
    await expect(strategy.validate(payload())).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
