import {
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../../users/user.schema';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly IDLE_TIMEOUT = 30 * 60 * 1000;

  constructor(
    configService: ConfigService,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (request) => request?.cookies?.access_token ?? null,
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('auth.jwtSecret'),
    });
  }

  async validate(payload: {
    sub: string;
    email: string;
    role: string;
  }) {
    const user = await this.userModel.findById(payload.sub);

    if (
      !user ||
      !user.isActive ||
      user.isSuspended ||
      user.deactivatedAt
    ) {
      throw new UnauthorizedException('Account is unavailable');
    }

    const now = Date.now();
    const lastActivity = user.lastActivityAt?.getTime();

    if (!lastActivity || now - lastActivity >= this.IDLE_TIMEOUT) {
      user.refreshTokenHash = null;
      await user.save();

      throw new UnauthorizedException(
        'Session expired due to inactivity. Please log in again.',
      );
    }

    user.lastActivityAt = new Date(now);
    await user.save();

    return {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
