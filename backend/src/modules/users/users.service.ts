import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../../users/user.schema';
import { UpdateProfileDto } from '../../users/dto/update-profile.dto';

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: User['role'];
  phone?: string | null;
  preferredCurrency: string;
  mustChangePassword: boolean;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
  ) {}

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.findAvailableUser(userId);
    return this.toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<PublicUser> {
    const user = await this.findAvailableUser(userId);

    const hasUpdates =
      dto.name !== undefined ||
      dto.phone !== undefined ||
      dto.preferredCurrency !== undefined;

    if (!hasUpdates) {
      throw new BadRequestException('Provide at least one field to update');
    }

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) {
        throw new BadRequestException('Name cannot be empty');
      }
      user.name = name;
    }

    if (dto.phone !== undefined) {
      user.phone = dto.phone?.trim() || null;
    }

    if (dto.preferredCurrency !== undefined) {
      user.preferredCurrency = dto.preferredCurrency.toUpperCase();
    }

    await user.save();
    return this.toPublicUser(user);
  }

  private async findAvailableUser(userId: string): Promise<UserDocument> {
    const user = await this.userModel.findById(userId);

    if (!user || !user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new UnauthorizedException('Account is unavailable');
    }

    return user;
  }

  private toPublicUser(user: UserDocument): PublicUser {
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