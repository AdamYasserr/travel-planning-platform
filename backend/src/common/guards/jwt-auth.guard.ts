import {
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_PASSWORD_CHANGE_KEY } from '../decorators/allow-password-change.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isPublic) {
      return true;
    }

    const authenticated = await super.canActivate(context);

    if (!authenticated) {
      return false;
    }

    const allowPasswordChange =
      this.reflector.getAllAndOverride<boolean>(
        ALLOW_PASSWORD_CHANGE_KEY,
        [context.getHandler(), context.getClass()],
      );

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (user?.mustChangePassword && !allowPasswordChange) {
      throw new ForbiddenException(
        'You must change your temporary password before accessing this feature',
      );
    }

    return true;
  }
}
