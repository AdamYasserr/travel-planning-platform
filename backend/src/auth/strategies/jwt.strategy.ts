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
import { IDLE_TIMEOUT_MS } from '../auth.constants';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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

    if (!lastActivity || now - lastActivity >= IDLE_TIMEOUT_MS) {
      await this.userModel.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null } });

      throw new UnauthorizedException(
        'Session expired due to inactivity. Please log in again.',
      );
    }

    // Each authenticated request extends the idle window.
    await this.userModel.updateOne({ _id: user._id }, { $set: { lastActivityAt: new Date(now) } });

    return {
      userId: user._id.toString(),
      email: user.email,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
