
import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import type { SignOptions } from 'jsonwebtoken';

import { User, UserDocument } from '../users/user.schema';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import { UsersService } from '../modules/users/users.service';

interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

@Injectable()
export class AuthService {
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  private readonly LOCK_TIME = 15 * 60 * 1000;
  private readonly IDLE_TIMEOUT = 30 * 60 * 1000;

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
      throw new ConflictException('Email is already registered');
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
        throw new ConflictException('Email is already registered');
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

    const user = await this.userModel
      .findOne({ email })
      .select('+password');

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new ForbiddenException('This account is unavailable');
    }

    if (user.lockUntil && user.lockUntil.getTime() > Date.now()) {
      throw new UnauthorizedException(
        'Account temporarily locked. Try again later.',
      );
    }

    if (user.lockUntil && user.lockUntil.getTime() <= Date.now()) {
      user.failedLoginAttempts = 0;
      user.lockUntil = null;
    }

    const passwordMatches = await bcrypt.compare(
      loginDto.password,
      user.password,
    );

    if (!passwordMatches) {
      user.failedLoginAttempts += 1;

      if (user.failedLoginAttempts >= this.MAX_LOGIN_ATTEMPTS) {
        user.lockUntil = new Date(Date.now() + this.LOCK_TIME);
      }

      await user.save();

      throw new UnauthorizedException('Invalid email or password');
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    user.lastActivityAt = new Date();

    const tokens = await this.generateTokens(user);

    user.refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 12);

    await user.save();

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

    const user = await this.userModel.findById(payload.sub);

    if (!user || !user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new UnauthorizedException('Account is unavailable');
    }

    if (!user.refreshTokenHash) {
      throw new UnauthorizedException('Session has been revoked');
    }

    const tokenMatches = await bcrypt.compare(
      refreshToken,
      user.refreshTokenHash,
    );

    if (!tokenMatches) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const lastActivity = user.lastActivityAt?.getTime();

    if (
      !lastActivity ||
      Date.now() - lastActivity >= this.IDLE_TIMEOUT
    ) {
      user.refreshTokenHash = null;
      await user.save();

      throw new UnauthorizedException(
        'Session expired due to inactivity. Please log in again.',
      );
    }

    const tokens = await this.generateTokens(user);

    user.refreshTokenHash = await bcrypt.hash(tokens.refreshToken, 12);

    await user.save();

    return {
      ...tokens,
      user: this.toPublicUser(user),
    };
  }

  async logout(refreshToken?: string) {
    if (refreshToken) {
      try {
        const payload = await this.jwtService.verifyAsync<TokenPayload>(
          refreshToken,
          {
            secret: this.configService.getOrThrow<string>(
              'auth.refreshTokenSecret',
            ),
          },
        );

        const user = await this.userModel.findById(payload.sub);

        if (user?.refreshTokenHash) {
          const tokenMatches = await bcrypt.compare(
            refreshToken,
            user.refreshTokenHash,
          );

          if (tokenMatches) {
            user.refreshTokenHash = null;
            await user.save();
          }
        }
      } catch {
        // Invalid or expired tokens are still cleared from the browser.
      }
    }

    return { message: 'Logged out successfully' };
  }

  async getCurrentUser(userId: string) {
    return this.usersService.getProfile(userId);
  }

  async deactivateAccount(userId: string) {
    const user = await this.userModel.findById(userId);

    if (!user || !user.isActive || user.deactivatedAt) {
      throw new UnauthorizedException('Account is unavailable');
    }

    user.isActive = false;
    user.deactivatedAt = new Date();
    user.refreshTokenHash = null;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;

    await user.save();

    return {
      message: 'Account deactivated successfully',
    };
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
