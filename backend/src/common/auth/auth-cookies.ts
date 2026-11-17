import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const ACCESS_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
export const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** ACC-19: httpOnly always; Secure from config (defaults to true in production, see configuration.ts). */
export function authCookieOptions(config: ConfigService, maxAge: number): CookieOptions {
  const secure = config.get<boolean>('auth.cookieSecure') ?? false;
  const domain = config.get<string>('auth.cookieDomain');
  return {
    httpOnly: true,
    secure,
    sameSite: secure ? 'none' : 'lax',
    maxAge,
    path: '/',
    ...(domain ? { domain } : {}),
  };
}

export function setAuthCookies(config: ConfigService, response: Response, tokens: { accessToken: string; refreshToken: string }) {
  response.cookie(ACCESS_COOKIE, tokens.accessToken, authCookieOptions(config, ACCESS_COOKIE_MAX_AGE_MS));
  response.cookie(REFRESH_COOKIE, tokens.refreshToken, authCookieOptions(config, REFRESH_COOKIE_MAX_AGE_MS));
}

export function clearAuthCookies(config: ConfigService, response: Response) {
  const { maxAge: _maxAge, ...options } = authCookieOptions(config, 0);
  response.clearCookie(ACCESS_COOKIE, options);
  response.clearCookie(REFRESH_COOKIE, options);
}
