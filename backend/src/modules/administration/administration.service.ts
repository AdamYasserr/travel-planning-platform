import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

import { User, UserDocument } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

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
}
