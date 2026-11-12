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
import { Airline, AirlineDocument } from '../airlines/schemas/airline.schema';
import { Hotel, HotelDocument } from '../hotels/schemas/hotel.schema';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  CreateModeratorDto,
  ProviderType,
} from './dto/create-moderator.dto';
import {
  AccountStatusFilter,
  QueryAccountsDto,
} from './dto/query-accounts.dto';
import { SuspendAccountDto } from './dto/suspend-account.dto';
import { ProviderStatusDto } from './dto/deactivate-provider.dto';

@Injectable()
export class AdministrationService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    @InjectModel(Airline.name)
    private readonly airlineModel: Model<AirlineDocument>,
    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<HotelDocument>,
    private readonly auditLogs: AuditLogsService,
  ) {}

  private getProviderModel(type: ProviderType): Model<any> {
    return type === ProviderType.HOTEL ? this.hotelModel : this.airlineModel;
  }

  async resetUserPassword(userId: string, actorId: string) {
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

    await this.auditLogs.record({
      actorId,
      action: 'PASSWORD_RESET',
      targetType: 'user',
      targetId: user._id.toString(),
      details: { email: user.email, role: user.role },
    });

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

  async createModerator(dto: CreateModeratorDto, actorId: string) {
    const email = dto.email.toLowerCase().trim();

    const existing = await this.userModel.findOne({ email });
    if (existing) {
      throw new ConflictException('Email is already in use');
    }

    const provider = await this.getProviderModel(dto.providerType)
      .findById(dto.providerId)
      .lean();
    if (!provider) {
      throw new NotFoundException(`${dto.providerType} not found`);
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

    await this.auditLogs.record({
      actorId,
      action: 'MODERATOR_CREATED',
      targetType: 'user',
      targetId: user._id.toString(),
      details: {
        email: user.email,
        providerType: dto.providerType,
        providerId: dto.providerId,
      },
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

  async suspendAccount(userId: string, dto: SuspendAccountDto, actorId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid account id');
    }
    if (userId === actorId) {
      throw new BadRequestException('You cannot suspend your own account');
    }

    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('Account not found');
    }
    if (user.role !== UserRole.USER && user.role !== UserRole.MODERATOR) {
      throw new BadRequestException(
        'Only registered user and moderator accounts can be suspended',
      );
    }
    if (user.isSuspended) {
      throw new ConflictException('Account is already suspended');
    }

    user.isSuspended = true;
    // End any existing session so the suspension takes effect immediately.
    user.refreshTokenHash = null;
    await user.save();

    await this.auditLogs.record({
      actorId,
      action: 'ACCOUNT_SUSPENDED',
      targetType: 'user',
      targetId: user._id.toString(),
      details: { email: user.email, role: user.role, reason: dto.reason ?? null },
    });

    return {
      message: 'Account suspended',
      user: { id: user._id.toString(), email: user.email, isSuspended: true },
    };
  }

  async reactivateAccount(userId: string, dto: SuspendAccountDto, actorId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid account id');
    }

    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException('Account not found');
    }
    if (!user.isSuspended) {
      throw new ConflictException('Account is not suspended');
    }

    user.isSuspended = false;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    await this.auditLogs.record({
      actorId,
      action: 'ACCOUNT_REACTIVATED',
      targetType: 'user',
      targetId: user._id.toString(),
      details: { email: user.email, role: user.role, reason: dto.reason ?? null },
    });

    return {
      message: 'Account reactivated',
      user: { id: user._id.toString(), email: user.email, isSuspended: false },
    };
  }

  async setProviderActive(
    type: ProviderType,
    providerId: string,
    active: boolean,
    dto: ProviderStatusDto,
    actorId: string,
  ) {
    if (!Types.ObjectId.isValid(providerId)) {
      throw new BadRequestException('Invalid provider id');
    }

    const model = this.getProviderModel(type);
    const provider = await model.findById(providerId).lean();
    if (!provider) {
      throw new NotFoundException(`${type} not found`);
    }
    if (provider.isActive === active) {
      throw new ConflictException(
        active ? `${type} is already active` : `${type} is already deactivated`,
      );
    }

    // Only the flag changes: existing Confirmed bookings stay valid.
    await model.updateOne({ _id: providerId }, { isActive: active });

    await this.auditLogs.record({
      actorId,
      action: active ? 'PROVIDER_REACTIVATED' : 'PROVIDER_DEACTIVATED',
      targetType: type,
      targetId: providerId,
      details: { name: provider.name, reason: dto.reason ?? null },
    });

    return {
      message: active ? `${type} reactivated` : `${type} deactivated`,
      provider: { id: providerId, name: provider.name, isActive: active },
    };
  }
}