import {
  Injectable,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { SignOptions } from 'jsonwebtoken';

import { User, UserDocument } from '../users/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import { UsersService } from '../modules/users/users.service';
import { IDLE_TIMEOUT_MS, LOCK_TIME_MS, MAX_LOGIN_ATTEMPTS } from './auth.constants';

interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}


const INVALID_CREDENTIALS = 'Invalid email or password';
// Used to keep response time similar when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-0', 12);

/** Refresh tokens are long JWTs: bcrypt would only see their first 72 bytes, so store a SHA-256 instead. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function tokenMatchesHash(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashRefreshToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersService: UsersService,
  ) {}

  async register(registerDto: RegisterDto) {
    const email = registerDto.email.trim().toLowerCase();

    const existingUser = await this.userModel.findOne({ email });

    if (existingUser) {
      throw this.emailTaken();
    }

    const hashedPassword = await bcrypt.hash(registerDto.password, 12);

    const user = new this.userModel({
      name: registerDto.name.trim(),
      email,
      password: hashedPassword,
      role: 'user',
      termsAcceptedAt: new Date(),
      lastActivityAt: new Date(),
    });

    try {
      await user.save();
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 11000
      ) {
        throw this.emailTaken();
      }

      throw new InternalServerErrorException('Could not create account');
    }

    return {
      message: 'Account created successfully',
      user: this.toPublicUser(user),
    };
  }

  async login(loginDto: LoginDto) {
    const email = loginDto.email.trim().toLowerCase();

    const user = await this.userModel.findOne({ email }).select('+password');

    // Unknown or deactivated accounts get the same generic answer as a wrong password.
    if (!user || !user.isActive || user.deactivatedAt) {
      await bcrypt.compare(loginDto.password, user?.password ?? DUMMY_HASH);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const now = new Date();

    if (user.lockUntil && user.lockUntil.getTime() > now.getTime()) {
      throw this.locked(user.lockUntil);
    }

    // An expired lock starts a fresh count (atomic, only if the lock is still the expired one).
    if (user.lockUntil) {
      await this.userModel.updateOne(
        { _id: user._id, lockUntil: { $lte: now } },
        { $set: { failedLoginAttempts: 0, lockUntil: null } },
      );
    }

    const passwordMatches = await bcrypt.compare(loginDto.password, user.password);

    if (!passwordMatches) {
      throw await this.recordFailedAttempt(user._id.toString());
    }

    // Suspension is only revealed to someone who proved they know the password.
    if (user.isSuspended) {
      throw new ForbiddenException('Your account has been suspended. Please contact support.');
    }

    const tokens = await this.generateTokens(user);

    // A successful login resets the failure counter.
    await this.userModel.updateOne(
      { _id: user._id },
      {
        $set: {
          failedLoginAttempts: 0,
          lockUntil: null,
          lastActivityAt: new Date(),
          refreshTokenHash: hashRefreshToken(tokens.refreshToken),
        },
      },
    );

    return {
      ...tokens,
      user: this.toPublicUser(user),
    };
  }

  async refreshSession(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    let payload: TokenPayload;

    try {
      payload = await this.jwtService.verifyAsync<TokenPayload>(
        refreshToken,
        {
          secret: this.configService.getOrThrow<string>(
            'auth.refreshTokenSecret',
          ),
        },
      );
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const user = await this.userModel
      .findById(payload.sub)
      .select('+refreshTokenHash');

    if (!user || !user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new UnauthorizedException('Account is unavailable');
    }

    if (!user.refreshTokenHash) {
      throw new UnauthorizedException('Session has been revoked');
    }

    if (!tokenMatchesHash(refreshToken, user.refreshTokenHash)) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const lastActivity = user.lastActivityAt?.getTime();

    if (!lastActivity || Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
      await this.userModel.updateOne({ _id: user._id }, { $set: { refreshTokenHash: null } });

      throw new UnauthorizedException(
        'Session expired due to inactivity. Please log in again.',
      );
    }

    const tokens = await this.generateTokens(user);

    // Rotation: only the newest refresh token is valid. Conditional so a replayed token cannot win a race.
    const rotated = await this.userModel.updateOne(
      { _id: user._id, refreshTokenHash: user.refreshTokenHash },
      { $set: { refreshTokenHash: hashRefreshToken(tokens.refreshToken) } },
    );
    if (rotated.modifiedCount !== 1) {
      throw new UnauthorizedException('Session has been revoked');
    }

    return {
      ...tokens,
      user: this.toPublicUser(user),
    };
  }

  /**
   * ACC-06: revokes the server-side session. Works with the refresh cookie, or with the access
   * cookie (even if expired) when the refresh cookie is missing or no longer valid.
   */
  async logout(refreshToken?: string, accessToken?: string) {
    const userId =
      (await this.revocableUserId(refreshToken, 'refresh')) ??
      (await this.revocableUserId(accessToken, 'access'));

    if (userId) {
      await this.userModel.updateOne({ _id: userId }, { $set: { refreshTokenHash: null } });
    }

    return { message: 'Logged out successfully' };
  }

  async getCurrentUser(userId: string) {
    return this.usersService.getProfile(userId);
  }

  /** Kept for DELETE /api/auth/account; same rules as DELETE /api/users/me. */
  async deactivateAccount(userId: string) {
    return this.usersService.deactivateAccount(userId);
  }

  async changePassword(
    userId: string,
    changePasswordDto: ChangePasswordDto,
  ) {
    const user = await this.userModel
      .findById(userId)
      .select('+password');

    if (!user || !user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new UnauthorizedException('Account is unavailable');
    }

    const currentPasswordMatches = await bcrypt.compare(
      changePasswordDto.currentPassword,
      user.password,
    );

    if (!currentPasswordMatches) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const samePassword = await bcrypt.compare(
      changePasswordDto.newPassword,
      user.password,
    );

    if (samePassword) {
      throw new ConflictException(
        'New password must be different from current password',
      );
    }

    user.password = await bcrypt.hash(changePasswordDto.newPassword, 12);
    user.mustChangePassword = false;
    user.refreshTokenHash = null;

    await user.save();

    return {
      message: 'Password changed successfully. Please log in again.',
    };
  }

  async updateProfile(
    userId: string,
    updateProfileDto: UpdateProfileDto,
  ) {
    const user = await this.usersService.updateProfile(
      userId,
      updateProfileDto,
    );
    return {
      message: 'Profile updated successfully',
      user,
    };
  }

  private async recordFailedAttempt(userId: string): Promise<HttpException> {
    const updated = await this.userModel.findOneAndUpdate(
      { _id: userId },
      { $inc: { failedLoginAttempts: 1 } },
      { new: true },
    );
    if (!updated) return new UnauthorizedException(INVALID_CREDENTIALS);

    if (updated.failedLoginAttempts >= MAX_LOGIN_ATTEMPTS) {
      // Only the request that first reaches the limit sets the lock; later ones read it.
      const locked = await this.userModel.findOneAndUpdate(
        { _id: userId, lockUntil: null },
        { $set: { lockUntil: new Date(Date.now() + LOCK_TIME_MS) } },
        { new: true },
      );
      const lockUntil = locked?.lockUntil ?? (await this.userModel.findById(userId))?.lockUntil;
      if (lockUntil) return this.locked(lockUntil);
    }
    return new UnauthorizedException(INVALID_CREDENTIALS);
  }

  private locked(lockedUntil: Date) {
    return new HttpException(
      {
        statusCode: 423,
        error: 'Locked',
        message: `Too many failed login attempts. Your account is locked until ${lockedUntil.toISOString()}.`,
        lockedUntil: lockedUntil.toISOString(),
      },
      423,
    );
  }

  private emailTaken() {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Email is already registered',
      errors: [{ field: 'email', messages: ['Email is already registered'] }],
    });
  }

  private async revocableUserId(token: string | undefined, kind: 'refresh' | 'access'): Promise<string | null> {
    if (!token) return null;
    try {
      const secret =
        kind === 'refresh'
          ? this.configService.getOrThrow<string>('auth.refreshTokenSecret')
          : this.configService.getOrThrow<string>('auth.jwtSecret');
      const payload = await this.jwtService.verifyAsync<TokenPayload>(token, {
        secret,
        ignoreExpiration: kind === 'access',
      });
      return payload.sub;
    } catch {
      return null;
    }
  }

  private async generateTokens(user: UserDocument) {
    const payload = {
      sub: user._id.toString(),
      email: user.email,
      role: user.role,
    };

    const accessToken = await this.jwtService.signAsync(payload);

    const refreshToken = await this.jwtService.signAsync(payload, {
      secret: this.configService.getOrThrow<string>(
        'auth.refreshTokenSecret',
      ),
      expiresIn: (this.configService.get<string>(
        'auth.refreshTokenExpiresIn',
      ) ?? '7d') as SignOptions['expiresIn'],
      jwtid: randomUUID(),
    });

    return { accessToken, refreshToken };
  }

  private toPublicUser(user: UserDocument) {
    return {
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      preferredCurrency: user.preferredCurrency,
      mustChangePassword: user.mustChangePassword,
    };
  }
}
