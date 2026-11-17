import { startApp, type E2EContext } from './helpers/app';
import { createUser } from './helpers/factories';

// Separate file (= separate app boot): ConfigModule reads COOKIE_SECURE once, when AppModule is imported.
describe('auth cookies with COOKIE_SECURE=true (ACC-19)', () => {
  let ctx: E2EContext;
  beforeAll(async () => { ctx = await startApp({ cookieSecure: true }); });
  afterAll(() => ctx.close());

  it('cookies are httpOnly, Secure and SameSite=None', async () => {
    const user = await createUser(ctx);
    const res = await ctx.http().post('/api/auth/login').send({ email: user.email, password: user.password });
    expect(res.status).toBe(201);
    const cookies: string[] = res.headers['set-cookie'];
    expect(cookies).toHaveLength(2);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/;\s*Secure/i);
      expect(cookie).toMatch(/SameSite=None/i);
    }
  });
});
