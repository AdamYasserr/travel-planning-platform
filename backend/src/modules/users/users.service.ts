import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../../users/user.schema';
import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
import { SupportedCurrenciesService } from '../reference-data/supported-currencies.service';
import { HotelBooking, HotelBookingStatus } from '../hotel-bookings/schemas/hotel-booking.schema';
import { FlightBooking } from '../flight-bookings/schemas/flight-booking.schema';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { Post } from '../blog/schemas/post.schema';
import { PostStatus } from '../blog/enums/post-status.enum';
import { Itinerary } from '../itineraries/schemas/itinerary.schema';
import { ItineraryVisibility } from '../itineraries/enums/itinerary-visibility.enum';
import { lastDepartureFilter } from '../../common/booking/booking-groups';

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
    private readonly currencies: SupportedCurrenciesService,
    @InjectModel(HotelBooking.name)
    private readonly hotelBookings: Model<HotelBooking>,
    @InjectModel(FlightBooking.name)
    private readonly flightBookings: Model<FlightBooking>,
    @InjectModel(Post.name)
    private readonly posts: Model<Post>,
    @InjectModel(Itinerary.name)
    private readonly itineraries: Model<Itinerary>,
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
      user.preferredCurrency = await this.currencies.assertSupported(
        dto.preferredCurrency,
        'preferredCurrency',
      );
    }

    await user.save();
    return this.toPublicUser(user);
  }

  /**
   * ACC-12: deactivates the account unless it has an upcoming Confirmed booking
   * (flight not yet departed, hotel stay not yet checked out). Afterwards the user's published posts
   * are hidden and public itineraries made private; comments and reviews remain but are shown as
   * "Deleted user" wherever they are presented.
   */
  async deactivateAccount(userId: string) {
    const user = await this.findAvailableUser(userId);
    const now = new Date();

    const [hotel, flight] = await Promise.all([
      this.hotelBookings.exists({ userId: user._id, status: HotelBookingStatus.CONFIRMED, checkOutDate: { $gt: now } }),
      // FLT-12: a round trip is upcoming until its return departs.
      this.flightBookings.exists({ userId: user._id, status: FlightBookingStatus.CONFIRMED, ...lastDepartureFilter({ $gt: now }) }),
    ]);
    if (hotel || flight) {
      throw new ConflictException(
        'You cannot delete your account while you have upcoming confirmed flight or hotel bookings. Cancel them or wait until they are completed.',
      );
    }

    user.isActive = false;
    user.deactivatedAt = now;
    user.refreshTokenHash = null;
    user.failedLoginAttempts = 0;
    user.lockUntil = null;
    await user.save();

    await Promise.all([
      this.posts.updateMany({ authorId: user._id, status: PostStatus.PUBLISHED }, { $set: { status: PostStatus.HIDDEN } }),
      this.itineraries.updateMany({ ownerId: user._id, visibility: ItineraryVisibility.PUBLIC }, { $set: { visibility: ItineraryVisibility.PRIVATE } }),
    ]);

    return { message: 'Account deactivated successfully' };
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