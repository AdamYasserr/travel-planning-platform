import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

import { User, UserDocument } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import {
  CreateModeratorDto,
  ProviderType,
} from './dto/create-moderator.dto';
import {
  AccountStatusFilter,
  QueryAccountsDto,
} from './dto/query-accounts.dto';

@Injectable()
export class AdministrationService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async resetUserPassword(userId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid account id');
    }

    const user = await this.userModel.findById(userId);

    if (!user) {
      throw new NotFoundException('Account not found');
    }

    if (user.role !== UserRole.USER && user.role !== UserRole.MODERATOR) {
      throw new BadRequestException(
        'Only registered user and moderator passwords can be reset',
      );
    }

    // "Temp-" guarantees letters and "-7" guarantees a digit.
    const temporaryPassword =
      `Temp-${randomBytes(8).toString('hex')}-7`;

    user.password = await bcrypt.hash(temporaryPassword, 12);
    user.mustChangePassword = true;

    // Revoke existing refresh sessions and clear any login lockout.
    user.refreshTokenHash = null;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;

    await user.save();

    // Return the temporary password only once to the admin.
    // Never log or persist the plaintext password.
    return {
      message: 'Password reset successfully',
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
      },
      temporaryPassword,
      mustChangePassword: true,
    };
  }

  async createModerator(dto: CreateModeratorDto) {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.userModel.findOne({ email });
    if (existing) {
      throw new ConflictException('Email is already in use');
    }

    const user = await this.userModel.create({
      name: dto.name,
      email,
      password: await bcrypt.hash(dto.password, 12),
      role: UserRole.MODERATOR,
      mustChangePassword: true,
      hotelId: dto.providerType === ProviderType.HOTEL ? dto.providerId : null,
      airlineId:
        dto.providerType === ProviderType.AIRLINE ? dto.providerId : null,
    });

    return {
      message: 'Moderator account created',
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        hotelId: user.hotelId,
        airlineId: user.airlineId,
      },
    };
  }

  async listAccounts(query: QueryAccountsDto) {
    const { role, status, search, page = 1, limit = 10 } = query;
    const filter: Record<string, any> = {};

    if (role) filter.role = role;

    if (status === AccountStatusFilter.ACTIVE) {
      filter.isActive = true;
      filter.isSuspended = false;
    } else if (status === AccountStatusFilter.SUSPENDED) {
      filter.isSuspended = true;
    } else if (status === AccountStatusFilter.DEACTIVATED) {
      filter.isActive = false;
    }

    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: escaped, $options: 'i' } },
        { email: { $regex: escaped, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select('-refreshTokenHash')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      this.userModel.countDocuments(filter),
    ]);

    return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
  }
}