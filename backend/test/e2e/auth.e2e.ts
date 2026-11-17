import { startApp, type E2EContext } from './helpers/app';
import { PASSWORD, createUser, login, unique } from './helpers/factories';
import { seedReference } from './helpers/reference';

const NEW_PASSWORD = 'N3wPassw0rd!';
const GENERIC = 'Invalid email or password';

/** Every property name in a JSON value, so we can assert no secret-looking field is exposed. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  return [];
}
const SECRET_KEY = /^(password|passwordHash|refreshTokenHash|accessToken|refreshToken|token)$/i;

describe('authentication, sessions and accounts (ACC-01/04/05/06/08/09/19, GEN-13)', () => {
  let ctx: E2EContext;
  let admin: Awaited<ReturnType<typeof createUser>>;

  beforeAll(async () => {
    ctx = await startApp();
    await seedReference(ctx);
    admin = await createUser(ctx, 'admin');
  });
  afterAll(() => ctx.close());

  const register = (body: Record<string, unknown> = {}) =>
    ctx.http().post('/api/auth/register').send({ name: 'Amina Test', email: `${unique('reg')}@e2e.test`, password: PASSWORD, acceptTerms: true, ...body });
  const attempt = (email: string, password: string) => ctx.http().post('/api/auth/login').send({ email, password });
  const cookiesOf = (res: { headers: Record<string, any> }): string[] => res.headers['set-cookie'] ?? [];
  const failedAttempts = async (email: string) => (await ctx.conn.model('User').findOne({ email }).lean() as any).failedLoginAttempts;

  describe('registration', () => {
    it.each([
      ['too short', 'Ab1'],
      ['no number', 'Passwordonly'],
      ['no letter', '1234567890'],
      ['longer than 72 bytes', 'a1'.repeat(37)],
    ])('weak password is rejected (400): %s', async (_name, password) => {
      const res = await register({ password });
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'password' })]));
    });

    it('a 72-byte password is accepted but 73 bytes is not (bytes, not characters)', async () => {
      expect((await register({ password: `a1${'x'.repeat(70)}` })).status).toBe(201);
      expect((await register({ password: `a1${'x'.repeat(71)}` })).status).toBe(400);
      // 36 two-byte characters + "a1" = 74 bytes in 38 characters
      expect((await register({ password: `a1${'é'.repeat(36)}` })).status).toBe(400);
    });

    it.each([
      ['missing', undefined],
      ['false', false],
      ['the string "false"', 'false'],
      ['the string "true"', 'true'],
    ])('acceptTerms %s is rejected (400)', async (_name, acceptTerms) => {
      const body: Record<string, unknown> = { name: 'A', email: `${unique('t')}@e2e.test`, password: PASSWORD };
      if (acceptTerms !== undefined) body.acceptTerms = acceptTerms;
      const res = await ctx.http().post('/api/auth/register').send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'acceptTerms' })]));
    });

    it('a duplicate email gives 409 with a field-level error, case-insensitively', async () => {
      const email = `${unique('dup')}@e2e.test`;
      expect((await register({ email })).status).toBe(201);
      const again = await register({ email: email.toUpperCase() });
      expect(again.status).toBe(409);
      expect(again.body.errors).toEqual([{ field: 'email', messages: ['Email is already registered'] }]);
    });

    it('validation errors use the { message, errors: [{ field, messages }] } shape', async () => {
      const res = await register({ email: 'not-an-email', password: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.message).toBeDefined();
      expect(res.body.errors.every((e: any) => typeof e.field === 'string' && Array.isArray(e.messages))).toBe(true);
    });

    it('registration returns no token and no password hash', async () => {
      const res = await register();
      expect(res.status).toBe(201);
      expect(keysOf(res.body).filter((k) => SECRET_KEY.test(k))).toEqual([]);
      expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);
    });
  });

  describe('login and cookies', () => {
    it('login sets httpOnly cookies and puts no token in the body', async () => {
      const user = await createUser(ctx, 'user', { viaApi: true });
      const res = await attempt(user.email, PASSWORD);
      expect(res.status).toBe(201);
      const cookies = cookiesOf(res);
      for (const name of ['access_token', 'refresh_token']) {
        const cookie = cookies.find((c) => c.startsWith(`${name}=`));
        expect(cookie).toBeDefined();
        expect(cookie).toMatch(/HttpOnly/i);
        expect(cookie).toMatch(/Path=\//);
        expect(cookie).not.toMatch(/;\s*Secure/i); // COOKIE_SECURE=false for plain-http tests; see auth-secure-cookie.e2e.ts
      }
      const tokenValues = cookies.map((c) => c.split(';')[0].split('=')[1]).filter((v) => v && v.length > 20);
      expect(tokenValues.length).toBeGreaterThanOrEqual(2);
      const body = JSON.stringify(res.body);
      expect(body).not.toMatch(/accessToken|refreshToken|"token"/i);
      for (const value of tokenValues) expect(body).not.toContain(value);
      expect(keysOf(res.body.user).filter((k) => SECRET_KEY.test(k))).toEqual([]);
    });

    it('5 wrong passwords give 401 four times and then 423 with lockedUntil', async () => {
      const user = await createUser(ctx);
      const statuses: number[] = [];
      let last: any;
      for (let i = 0; i < 5; i++) {
        last = await attempt(user.email, 'Wrong1234!');
        statuses.push(last.status);
      }
      expect(statuses).toEqual([401, 401, 401, 401, 423]);
      expect(last.body.lockedUntil).toBeDefined();
      const remaining = new Date(last.body.lockedUntil).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(14 * 60_000);
      expect(remaining).toBeLessThanOrEqual(15 * 60_000);
    });

    it('the correct password while locked is still 423', async () => {
      const user = await createUser(ctx);
      for (let i = 0; i < 5; i++) await attempt(user.email, 'Wrong1234!');
      const res = await attempt(user.email, PASSWORD);
      expect(res.status).toBe(423);
      expect(res.body.lockedUntil).toBeDefined();
    });

    it('an expired lock starts a fresh count', async () => {
      const user = await createUser(ctx);
      for (let i = 0; i < 5; i++) await attempt(user.email, 'Wrong1234!');
      await ctx.conn.model('User').updateOne({ email: user.email }, { $set: { lockUntil: new Date(Date.now() - 1000) } });
      expect((await attempt(user.email, 'Wrong1234!')).status).toBe(401);
      expect(await failedAttempts(user.email)).toBe(1);
      expect((await attempt(user.email, PASSWORD)).status).toBe(201);
    });

    it('a successful login resets the failure counter', async () => {
      const user = await createUser(ctx);
      for (let i = 0; i < 3; i++) expect((await attempt(user.email, 'Wrong1234!')).status).toBe(401);
      expect(await failedAttempts(user.email)).toBe(3);
      expect((await attempt(user.email, PASSWORD)).status).toBe(201);
      expect(await failedAttempts(user.email)).toBe(0);
      // the old failures no longer count towards a lock
      for (let i = 0; i < 4; i++) expect((await attempt(user.email, 'Wrong1234!')).status).toBe(401);
    });

    it('an unknown email gets the same generic message as a wrong password', async () => {
      const user = await createUser(ctx);
      const unknown = await attempt(`${unique('ghost')}@e2e.test`, PASSWORD);
      const wrong = await attempt(user.email, 'Wrong1234!');
      expect(unknown.status).toBe(401);
      expect(wrong.status).toBe(401);
      expect(unknown.body.message).toBe(GENERIC);
      expect(wrong.body.message).toBe(GENERIC);
    });

    it('a suspended user with a wrong password gets the generic message, with the right one "suspended"', async () => {
      const user = await createUser(ctx);
      const suspend = await admin.agent.patch(`/api/admin/accounts/${user.id}/suspend`);
      expect(suspend.status).toBeLessThan(300);

      const wrong = await attempt(user.email, 'Wrong1234!');
      expect(wrong.status).toBe(401);
      expect(wrong.body.message).toBe(GENERIC);

      const right = await attempt(user.email, PASSWORD);
      expect(right.status).toBe(403);
      expect(right.body.message).toMatch(/suspended/i);
      expect(cookiesOf(right)).toHaveLength(0);
    });
  });

  describe('/auth/me and sessions', () => {
    it('/auth/me returns the profile with a cookie and 401 without one', async () => {
      const user = await createUser(ctx);
      const me = await user.agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.email).toBe(user.email);
      expect(keysOf(me.body).filter((k) => SECRET_KEY.test(k))).toEqual([]);
      expect((await ctx.http().get('/api/auth/me')).status).toBe(401);
    });

    it('a tampered access cookie is 401', async () => {
      const res = await ctx.http().get('/api/auth/me').set('Cookie', 'access_token=not.a.jwt');
      expect(res.status).toBe(401);
    });

    it('logout clears the session: /auth/me is 401 and the old cookies no longer work', async () => {
      const user = await createUser(ctx);
      const fresh = await attempt(user.email, PASSWORD);
      const oldRefresh = cookiesOf(fresh).find((c) => c.startsWith('refresh_token='))!.split(';')[0];

      const agent = ctx.agent();
      await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
      expect((await agent.get('/api/auth/me')).status).toBe(200);
      expect((await agent.post('/api/auth/logout')).status).toBe(201);
      expect((await agent.get('/api/auth/me')).status).toBe(401);

      // The first session was replaced by the second login (single refresh token), so its refresh cookie is dead.
      expect((await ctx.http().post('/api/auth/refresh').set('Cookie', oldRefresh)).status).toBe(401);
    });

    it('a refresh cookie captured before logout fails after logout', async () => {
      const user = await createUser(ctx);
      const agent = ctx.agent();
      const loginRes = await agent.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
      const refresh = cookiesOf(loginRes).find((c) => c.startsWith('refresh_token='))!.split(';')[0];
      expect((await ctx.http().post('/api/auth/refresh').set('Cookie', refresh)).status).toBe(201);
      // refreshing rotated the token, so log in again to test logout on a known token
      const again = await ctx.agent();
      const second = await again.post('/api/auth/login').send({ email: user.email, password: PASSWORD });
      const r2 = cookiesOf(second).find((c) => c.startsWith('refresh_token='))!.split(';')[0];
      await again.post('/api/auth/logout');
      expect((await ctx.http().post('/api/auth/refresh').set('Cookie', r2)).status).toBe(401);
      // Known limit (reported, not asserted): a copied ACCESS token keeps working until it expires (15 min);
      // logout revokes the refresh token and clears the cookies, it does not blacklist the access JWT.
    });

    it('a rotated refresh token cannot be used twice', async () => {
      const user = await createUser(ctx);
      const res = await attempt(user.email, PASSWORD);
      const refresh = cookiesOf(res).find((c) => c.startsWith('refresh_token='))!.split(';')[0];
      expect((await ctx.http().post('/api/auth/refresh').set('Cookie', refresh)).status).toBe(201);
      expect((await ctx.http().post('/api/auth/refresh').set('Cookie', refresh)).status).toBe(401);
    });

    it('a session idle for more than 30 minutes expires (ACC-06)', async () => {
      const user = await createUser(ctx);
      expect((await user.agent.get('/api/auth/me')).status).toBe(200);
      await ctx.conn.model('User').updateOne({ email: user.email }, { $set: { lastActivityAt: new Date(Date.now() - 31 * 60_000) } });
      expect((await user.agent.get('/api/auth/me')).status).toBe(401);
    });

    it('activity within the window keeps the session alive (ACC-06)', async () => {
      const user = await createUser(ctx);
      await ctx.conn.model('User').updateOne({ email: user.email }, { $set: { lastActivityAt: new Date(Date.now() - 20 * 60_000) } });
      expect((await user.agent.get('/api/auth/me')).status).toBe(200);
    });
  });

  describe('change password', () => {
    it.each([
      ['PATCH', 200],
      ['POST', 201],
    ] as const)('change-password via %s works, ends the session and the new password logs in', async (method, status) => {
      const user = await createUser(ctx);
      const call = method === 'PATCH' ? user.agent.patch.bind(user.agent) : user.agent.post.bind(user.agent);
      const res = await call('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
      expect(res.status).toBe(status);

      expect((await user.agent.get('/api/auth/me')).status).toBe(401);
      expect((await attempt(user.email, PASSWORD)).status).toBe(401);
      expect((await attempt(user.email, NEW_PASSWORD)).status).toBe(201);
    });

    it.each(['PATCH', 'POST'] as const)('change-password via %s rejects a wrong current password (401) and a weak new one (400)', async (method) => {
      const user = await createUser(ctx);
      const call = method === 'PATCH' ? user.agent.patch.bind(user.agent) : user.agent.post.bind(user.agent);
      expect((await call('/api/auth/change-password').send({ currentPassword: 'Wrong1234!', newPassword: NEW_PASSWORD })).status).toBe(401);
      expect((await call('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'short' })).status).toBe(400);
      expect((await attempt(user.email, PASSWORD)).status).toBe(201);
    });

    it('change-password needs a login (401)', async () => {
      expect((await ctx.http().patch('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
    });

    it('an admin password reset forces a change: users/me 403, auth/me ok, change-password ok', async () => {
      const user = await createUser(ctx);
      const reset = await admin.agent.post(`/api/admin/users/${user.id}/reset-password`);
      expect(reset.status).toBe(201);
      const temp = reset.body.temporaryPassword as string;

      // the old password is gone, the temporary one works
      expect((await attempt(user.email, PASSWORD)).status).toBe(401);
      const agent = await login(ctx, user.email, temp);

      const blocked = await agent.get('/api/users/me');
      expect(blocked.status).toBe(403);
      expect(blocked.body.message).toMatch(/change your temporary password/i);
      const me = await agent.get('/api/auth/me');
      expect(me.status).toBe(200);
      expect(me.body.user.mustChangePassword).toBe(true);

      const changed = await agent.post('/api/auth/change-password').send({ currentPassword: temp, newPassword: NEW_PASSWORD });
      expect(changed.status).toBe(201);
      const after = await login(ctx, user.email, NEW_PASSWORD);
      expect((await after.get('/api/users/me')).status).toBe(200);
    });

    it('a moderator created by an admin must change the password before using the API', async () => {
      const hotel = await createUserHotel();
      const mod = await admin.agent.post('/api/admin/moderators').send({ name: 'Hotel Mod', email: `${unique('mod')}@e2e.test`, providerType: 'hotel', providerId: hotel });
      expect(mod.status).toBe(201);
      const reset = await admin.agent.post(`/api/admin/users/${mod.body.account.id}/reset-password`);
      const agent = await login(ctx, mod.body.account.email, reset.body.temporaryPassword);
      expect((await agent.get(`/api/hotels/${hotel}/rooms`)).status).toBe(403);
    });
  });

  async function createUserHotel(): Promise<string> {
    const res = await admin.agent.post('/api/hotels').send({
      name: unique('Hotel'), address: '1 Road', cityId: 'cairo', countryId: 'EG', starClass: 3, checkInTime: '15:00', checkOutTime: '11:00',
    });
    if (res.status !== 201) throw new Error(`hotel create failed: ${res.status} ${JSON.stringify(res.body)}`);
    return String(res.body._id ?? res.body.id);
  }
});
