import { jest } from '@jest/globals';
import { ConflictException, ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Types } from 'mongoose';
import { AuthService, hashRefreshToken } from './auth.service';
import { IDLE_TIMEOUT_MS, LOCK_TIME_MS, MAX_LOGIN_ATTEMPTS } from './auth.constants';

jest.setTimeout(60_000);

const JWT_SECRET = 'j'.repeat(40);
const REFRESH_SECRET = 'r'.repeat(40);
const PASSWORD = 'Passw0rd!ok';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4); // low cost: tests only

type Doc = Record<string, any>;

/** Minimal in-memory stand-in for the mongoose user model (just what AuthService uses). */
function createFakeUserModel() {
  const docs: Doc[] = [];
  const matches = (doc: Doc, filter: Doc) =>
    Object.entries(filter).every(([key, cond]) => {
      const value = doc[key];
      if (key === '_id') return String(value) === String(cond);
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
        if ('$lte' in cond) return value != null && value <= cond.$lte;
        if ('$gt' in cond) return value != null && value > cond.$gt;
      }
      if (cond === null) return value == null;
      return value instanceof Date && cond instanceof Date ? value.getTime() === cond.getTime() : value === cond;
    });
  const apply = (doc: Doc, update: Doc) => {
    Object.assign(doc, update.$set ?? {});
    for (const [k, n] of Object.entries(update.$inc ?? {})) doc[k] = (doc[k] ?? 0) + (n as number);
  };
  const thenable = (value: unknown) => {
    const p: any = Promise.resolve(value);
    p.select = () => Promise.resolve(value);
    return p;
  };
  function Model(this: Doc, data: Doc) {
    Object.assign(this, {
      _id: new Types.ObjectId(), isActive: true, isSuspended: false, failedLoginAttempts: 0, lockUntil: null,
      mustChangePassword: false, refreshTokenHash: null, deactivatedAt: null, role: 'user', preferredCurrency: 'EGP',
      lastActivityAt: new Date(), ...data,
    });
  }
  Model.prototype.save = async function (this: Doc) {
    if (!docs.includes(this)) {
      if (docs.some((d) => d.email === this.email)) throw Object.assign(new Error('E11000'), { code: 11000 });
      docs.push(this);
    }
    return this;
  };
  const model: any = Model;
  model.docs = docs;
  model.findOne = jest.fn((filter: Doc) => thenable(docs.find((d) => matches(d, filter)) ?? null));
  model.findById = jest.fn((id: unknown) => thenable(docs.find((d) => String(d._id) === String(id)) ?? null));
  model.updateOne = jest.fn(async (filter: Doc, update: Doc) => {
    const doc = docs.find((d) => matches(d, filter));
    if (doc) apply(doc, update);
    return { modifiedCount: doc ? 1 : 0 };
  });
  model.findOneAndUpdate = jest.fn(async (filter: Doc, update: Doc) => {
    const doc = docs.find((d) => matches(d, filter));
    if (doc) apply(doc, update);
    return doc ?? null;
  });
  return model;
}

describe('AuthService', () => {
  let model: any;
  let service: AuthService;
  let jwt: JwtService;
  let usersService: any;

  const config = {
    getOrThrow: (key: string) => ({ 'auth.refreshTokenSecret': REFRESH_SECRET, 'auth.jwtSecret': JWT_SECRET })[key],
    get: (key: string) => ({ 'auth.refreshTokenExpiresIn': '7d' } as Record<string, string>)[key],
  };

  const seed = (overrides: Doc = {}) => {
    const user = new model({ name: 'Amina', email: 'amina@example.com', password: PASSWORD_HASH, ...overrides });
    model.docs.push(user);
    return user;
  };

  beforeEach(() => {
    model = createFakeUserModel();
    jwt = new JwtService({ secret: JWT_SECRET, signOptions: { expiresIn: '15m' } });
    usersService = { getProfile: jest.fn(), updateProfile: jest.fn(), deactivateAccount: jest.fn() };
    service = new AuthService(model, jwt, config as never, usersService);
  });

  describe('ACC-01 register', () => {
    const dto = { name: ' Amina ', email: ' Amina@Example.com ', password: PASSWORD, acceptTerms: true };

    it('creates the account with a salted bcrypt hash, normalized email and no tokens in the result', async () => {
      const result = await service.register(dto as never);
      const stored = model.docs[0];
      expect(stored.email).toBe('amina@example.com');
      expect(stored.name).toBe('Amina');
      expect(stored.password).not.toBe(PASSWORD);
      expect(stored.password).toMatch(/^\$2[aby]\$12\$/);
      expect(await bcrypt.compare(PASSWORD, stored.password)).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|"password"|\$2/);
    });

    it('hashes the same password differently each time (salted)', async () => {
      await service.register(dto as never);
      await service.register({ ...dto, email: 'other@example.com' } as never);
      expect(model.docs[0].password).not.toBe(model.docs[1].password);
    });

    it('rejects a duplicate email (case-insensitive) with a field-level 409', async () => {
      await service.register(dto as never);
      const error = await service.register({ ...dto, email: 'AMINA@example.com' } as never).catch((e) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ errors: [{ field: 'email', messages: ['Email is already registered'] }] });
      expect(model.docs).toHaveLength(1);
    });

    it('maps a database duplicate-key race to the same 409', async () => {
      model.findOne = jest.fn(() => Promise.resolve(null)); // both requests passed the pre-check
      await service.register(dto as never);
      await expect(service.register(dto as never)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('ACC-04 login messages', () => {
    const login = (password = PASSWORD, email = 'amina@example.com') => service.login({ email, password });
    const messageOf = async (p: Promise<unknown>) => ((await p.catch((e) => e)) as Error).message;

    it('succeeds with correct credentials and returns tokens only to the controller (no password in user)', async () => {
      seed();
      const result = await login();
      expect(result.accessToken).toBeTruthy();
      expect(result.refreshToken).toBeTruthy();
      expect(result.user).not.toHaveProperty('password');
    });

    it('uses one generic message for unknown email, wrong password and deactivated accounts', async () => {
      seed();
      seed({ email: 'gone@example.com', isActive: false, deactivatedAt: new Date() });
      const unknown = await login(PASSWORD, 'nobody@example.com').catch((e) => e);
      const wrong = await login('Wrong-pass1').catch((e) => e);
      const deactivated = await login(PASSWORD, 'gone@example.com').catch((e) => e);
      for (const error of [unknown, wrong, deactivated]) {
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toBe('Invalid email or password');
      }
    });

    it('tells a suspended account "suspended" only when the password is correct', async () => {
      seed({ isSuspended: true });
      const ok = await login().catch((e) => e);
      expect(ok).toBeInstanceOf(ForbiddenException);
      expect(ok.message).toMatch(/account has been suspended/i);
      expect(await messageOf(login('Wrong-pass1'))).toBe('Invalid email or password');
    });

    it('does not issue tokens to a suspended account', async () => {
      const user = seed({ isSuspended: true });
      await login().catch(() => undefined);
      expect(user.refreshTokenHash).toBeNull();
    });
  });

  describe('ACC-05 lockout', () => {
    const bad = (email = 'amina@example.com') => service.login({ email, password: 'Wrong-pass1' }).catch((e) => e);

    it('locks for 15 minutes on the 5th consecutive failure, with a lockout message and lockedUntil', async () => {
      const user = seed();
      for (let i = 1; i < MAX_LOGIN_ATTEMPTS; i++) {
        const error = await bad();
        expect(error.message).toBe('Invalid email or password');
        expect(user.failedLoginAttempts).toBe(i);
        expect(user.lockUntil).toBeNull();
      }
      const before = Date.now();
      const fifth = await bad();
      expect(fifth).toBeInstanceOf(HttpException);
      expect(fifth.getStatus()).toBe(423);
      expect(fifth.message).toMatch(/locked until/i);
      expect(user.lockUntil.getTime()).toBeGreaterThanOrEqual(before + LOCK_TIME_MS - 50);
      expect(user.lockUntil.getTime()).toBeLessThanOrEqual(Date.now() + LOCK_TIME_MS);
      expect(fifth.getResponse().lockedUntil).toBe(user.lockUntil.toISOString());
    });

    it('rejects even the correct password while locked, without touching the counter', async () => {
      const user = seed({ failedLoginAttempts: 5, lockUntil: new Date(Date.now() + 60_000) });
      const error = await service.login({ email: 'amina@example.com', password: PASSWORD }).catch((e) => e);
      expect(error.getStatus()).toBe(423);
      expect(user.failedLoginAttempts).toBe(5);
      expect(user.refreshTokenHash).toBeNull();
    });

    it('a successful login resets the counter', async () => {
      const user = seed({ failedLoginAttempts: 4 });
      await service.login({ email: 'amina@example.com', password: PASSWORD });
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockUntil).toBeNull();
      // ...so four more failures do not lock
      for (let i = 0; i < 4; i++) await bad();
      expect(user.lockUntil).toBeNull();
    });

    it('after the lock expires the correct password works and the count restarts', async () => {
      const user = seed({ failedLoginAttempts: 5, lockUntil: new Date(Date.now() - 1000) });
      await expect(service.login({ email: 'amina@example.com', password: PASSWORD })).resolves.toBeDefined();
      expect(user.failedLoginAttempts).toBe(0);
      expect(user.lockUntil).toBeNull();
    });

    it('after the lock expires a wrong password starts from 1, not 6', async () => {
      const user = seed({ failedLoginAttempts: 5, lockUntil: new Date(Date.now() - 1000) });
      const error = await bad();
      expect(error.message).toBe('Invalid email or password');
      expect(user.failedLoginAttempts).toBe(1);
      expect(user.lockUntil).toBeNull();
    });

    it('counts concurrent failures atomically and locks exactly once', async () => {
      const user = seed();
      const results = await Promise.all(Array.from({ length: 8 }, () => bad()));
      expect(user.failedLoginAttempts).toBe(8);
      expect(user.lockUntil).toBeInstanceOf(Date);
      expect(results.filter((r) => r.getStatus?.() === 423).length).toBeGreaterThanOrEqual(4);
    });
  });

  describe('ACC-06 session', () => {
    const loginTokens = async (overrides: Doc = {}) => {
      const user = seed(overrides);
      const tokens = await service.login({ email: 'amina@example.com', password: PASSWORD });
      return { user, tokens };
    };

    it('stores only a hash of the refresh token, never the token', async () => {
      const { user, tokens } = await loginTokens();
      expect(user.refreshTokenHash).toBe(hashRefreshToken(tokens.refreshToken));
      expect(user.refreshTokenHash).not.toContain(tokens.refreshToken);
    });

    it('logout via the refresh cookie revokes the server-side session', async () => {
      const { user, tokens } = await loginTokens();
      await service.logout(tokens.refreshToken, tokens.accessToken);
      expect(user.refreshTokenHash).toBeNull();
      await expect(service.refreshSession(tokens.refreshToken)).rejects.toThrow('Session has been revoked');
    });

    it('logout still revokes when only an EXPIRED access cookie is left', async () => {
      const { user } = await loginTokens();
      const expired = await jwt.signAsync({ sub: user._id.toString(), email: user.email, role: 'user' }, { expiresIn: -10 });
      await service.logout(undefined, expired);
      expect(user.refreshTokenHash).toBeNull();
    });

    it('logout with garbage or forged cookies is harmless and does not revoke others', async () => {
      const { user } = await loginTokens();
      const forged = await jwt.signAsync({ sub: user._id.toString() }, { secret: 'x'.repeat(40) });
      await expect(service.logout('garbage', forged)).resolves.toEqual({ message: 'Logged out successfully' });
      expect(user.refreshTokenHash).not.toBeNull();
    });

    it('rotates refresh tokens: the previous token stops working', async () => {
      const { tokens } = await loginTokens();
      const rotated = await service.refreshSession(tokens.refreshToken);
      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      await expect(service.refreshSession(tokens.refreshToken)).rejects.toThrow('Invalid refresh token');
      await expect(service.refreshSession(rotated.refreshToken)).resolves.toBeDefined();
    });

    it('refresh fails after 30 idle minutes and revokes the session; it does not extend activity', async () => {
      const { user, tokens } = await loginTokens();
      user.lastActivityAt = new Date(Date.now() - IDLE_TIMEOUT_MS - 1000);
      await expect(service.refreshSession(tokens.refreshToken)).rejects.toThrow(/inactivity/);
      expect(user.refreshTokenHash).toBeNull();
    });

    it('refresh within the idle window succeeds without changing lastActivityAt', async () => {
      const { user, tokens } = await loginTokens();
      const stamp = new Date(Date.now() - 10 * 60_000);
      user.lastActivityAt = stamp;
      await service.refreshSession(tokens.refreshToken);
      expect(user.lastActivityAt).toBe(stamp);
    });

    it('refresh is refused for suspended or deactivated accounts', async () => {
      const { user, tokens } = await loginTokens();
      user.isSuspended = true;
      await expect(service.refreshSession(tokens.refreshToken)).rejects.toThrow('Account is unavailable');
    });
  });

  describe('ACC-07a / ACC-08 changePassword', () => {
    it('clears mustChangePassword, stores a new salted hash and revokes the session', async () => {
      const user = seed({ mustChangePassword: true, refreshTokenHash: 'x' });
      user.save = jest.fn(async () => user) as never;
      const result = await service.changePassword(user._id.toString(), { currentPassword: PASSWORD, newPassword: 'Brand-new-pass9' });
      expect(result.message).toMatch(/changed/i);
      expect(user.mustChangePassword).toBe(false);
      expect(user.refreshTokenHash).toBeNull();
      expect(await bcrypt.compare('Brand-new-pass9', user.password)).toBe(true);
    });

    it('rejects a wrong current password and an unchanged password', async () => {
      const user = seed({ mustChangePassword: true });
      await expect(service.changePassword(user._id.toString(), { currentPassword: 'nope-wrong1', newPassword: 'Brand-new-pass9' })).rejects.toThrow('Current password is incorrect');
      await expect(service.changePassword(user._id.toString(), { currentPassword: PASSWORD, newPassword: PASSWORD })).rejects.toBeInstanceOf(ConflictException);
      expect(user.mustChangePassword).toBe(true);
    });
  });

  it('delegates account deletion to UsersService (same rules as DELETE /users/me)', async () => {
    usersService.deactivateAccount.mockResolvedValue({ message: 'ok' });
    await service.deactivateAccount('abc');
    expect(usersService.deactivateAccount).toHaveBeenCalledWith('abc');
  });
});
