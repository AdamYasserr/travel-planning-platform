import { jest } from '@jest/globals';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from './jwt-auth.guard';
import { AllowPasswordChange, ALLOW_PASSWORD_CHANGE_KEY } from '../decorators/allow-password-change.decorator';
import { Public } from '../decorators/public.decorator';
import { AuthController } from '../../auth/auth.controller';
import { UsersController } from '../../modules/users/users.controller';

/** ACC-07a / ACC-13: the forced password change must be ENFORCED on every other endpoint. */
describe('JwtAuthGuard forced password change', () => {
  class Sample {
    normal() {}
    @AllowPasswordChange() allowed() {}
    @Public() open() {}
  }
  const reflector = new Reflector();
  const guard = new JwtAuthGuard(reflector);
  const parent = Object.getPrototypeOf(JwtAuthGuard.prototype);

  const contextFor = (handler: () => void, user: Record<string, unknown> | undefined) => {
    const request: Record<string, unknown> = {};
    const context = {
      getHandler: () => handler,
      getClass: () => Sample,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    // passport would populate request.user after validating the cookie
    jest.spyOn(parent, 'canActivate').mockImplementation((async () => {
      request.user = user;
      return true;
    }) as never);
    return context;
  };
  const sample = new Sample();
  const tempUser = { userId: 'u1', role: 'user', mustChangePassword: true };
  const normalUser = { userId: 'u1', role: 'user', mustChangePassword: false };

  afterEach(() => jest.restoreAllMocks());

  it('blocks a must-change user on an ordinary endpoint with 403', async () => {
    await expect(guard.canActivate(contextFor(sample.normal, tempUser))).rejects.toThrow(ForbiddenException);
    await expect(guard.canActivate(contextFor(sample.normal, tempUser))).rejects.toThrow(/change your temporary password/i);
  });

  it('lets a must-change user reach endpoints marked @AllowPasswordChange', async () => {
    await expect(guard.canActivate(contextFor(sample.allowed, tempUser))).resolves.toBe(true);
  });

  it('does not affect users without the flag', async () => {
    await expect(guard.canActivate(contextFor(sample.normal, normalUser))).resolves.toBe(true);
  });

  it('skips authentication entirely on @Public endpoints', async () => {
    const spy = jest.spyOn(parent, 'canActivate');
    const context = contextFor(sample.open, undefined);
    spy.mockClear();
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is the global guard base class (AuthGuard jwt)', () => {
    expect(parent).toBe(AuthGuard('jwt').prototype);
  });

  describe('real controllers: only the intended routes bypass the check', () => {
    const allowedHandlers = (controller: { prototype: object }) =>
      Object.getOwnPropertyNames(controller.prototype)
        .filter((name) => name !== 'constructor' && typeof (controller.prototype as any)[name] === 'function')
        .filter((name) => Reflect.getMetadata(ALLOW_PASSWORD_CHANGE_KEY, (controller.prototype as any)[name]));

    it('AuthController: only change-password and /auth/me', () => {
      expect(allowedHandlers(AuthController).sort()).toEqual(['changePassword', 'getMe']);
    });

    it('UsersController: no route is exempt (profile, delete account all require the change first)', () => {
      expect(allowedHandlers(UsersController)).toEqual([]);
    });
  });
});
