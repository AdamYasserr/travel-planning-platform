
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { ForbiddenException } from '@nestjs/common';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

import {
  HotelBooking,
  HotelBookingStatus,
} from './schemas/hotel-booking.schema';
import { Hotel } from '../hotels/schemas/hotel.schema';
import { Room } from '../hotels/schemas/room.schema';
import { CreateHotelBookingDto } from './dto/hotel-bookings.dto';

const HOLD_DURATION_MS = 10 * 60 * 1000;

@Injectable()
export class HotelBookingsService {
  constructor(
    @InjectModel(HotelBooking.name)
    private readonly bookingModel: Model<HotelBooking>,

    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<Hotel>,

    @InjectModel(Room.name)
    private readonly roomModel: Model<Room>,

    @InjectConnection()
    private readonly connection: Connection,
    @InjectModel(User.name)
private readonly userModel: Model<User>,
  ) {}

  private isStayCoveredByRanges(
    ranges: Array<{ startDate: Date; endDate: Date }>,
    checkInDate: Date,
    checkOutDate: Date,
  ): boolean {
    const sortedRanges = [...ranges].sort(
      (a, b) =>
        new Date(a.startDate).getTime() -
        new Date(b.startDate).getTime(),
    );

    let coveredUntil = checkInDate.getTime();
    const requiredUntil = checkOutDate.getTime();

    for (const range of sortedRanges) {
      const start = new Date(range.startDate).getTime();
      const end = new Date(range.endDate).getTime();

      if (end <= coveredUntil) continue;
      if (start > coveredUntil) return false;

      coveredUntil = Math.max(coveredUntil, end);

      if (coveredUntil >= requiredUntil) return true;
    }

    return false;
  }

  // HTL-16 and HTL-18:
  // Create one pending reservation and hold all selected rooms for 10 minutes.
  async createHold(userId: string, dto: CreateHotelBookingDto) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }

    if (!Types.ObjectId.isValid(dto.hotelId)) {
      throw new BadRequestException('Invalid hotel ID');
    }

    const checkInDate = new Date(dto.checkInDate);
    const checkOutDate = new Date(dto.checkOutDate);

    if (
      Number.isNaN(checkInDate.getTime()) ||
      Number.isNaN(checkOutDate.getTime())
    ) {
      throw new BadRequestException('Invalid booking dates');
    }

    // Normalize dates to UTC midnight.
    checkInDate.setUTCHours(0, 0, 0, 0);
    checkOutDate.setUTCHours(0, 0, 0, 0);

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    if (checkInDate < today) {
      throw new BadRequestException(
        'Check-in date cannot be in the past',
      );
    }

    if (checkOutDate <= checkInDate) {
      throw new BadRequestException(
        'Check-out must be after check-in',
      );
    }

    const totalAdults = dto.rooms.reduce(
      (sum, room) => sum + room.adults,
      0,
    );

    if (totalAdults < 1) {
      throw new BadRequestException(
        'At least one adult is required per reservation',
      );
    }

    const roomIds = dto.rooms.map(
      (room) => new Types.ObjectId(room.roomId),
    );

    if (new Set(roomIds.map(String)).size !== roomIds.length) {
      throw new BadRequestException('Duplicate room selections');
    }

    const session = await this.connection.startSession();

    try {
      let createdBooking: any;

      await session.withTransaction(async () => {
        const now = new Date();

        const hotel = await this.hotelModel
          .findOne({
            _id: new Types.ObjectId(dto.hotelId),
            isActive: true,
          })
          .session(session)
          .exec();

        if (!hotel) {
          throw new NotFoundException('Active hotel not found');
        }

        // Reject rooms already confirmed or held for overlapping dates.
        const conflictingBooking = await this.bookingModel
          .findOne({
            'rooms.roomId': { $in: roomIds },
            checkInDate: { $lt: checkOutDate },
            checkOutDate: { $gt: checkInDate },
            $or: [
              { status: HotelBookingStatus.CONFIRMED },
              {
                status: HotelBookingStatus.PENDING_PAYMENT,
                $or: [
                  { holdExpiresAt: { $gt: now } },
                  { holdExpiresAt: null },
                ],
              },
            ],
          })
          .session(session)
          .exec();

        if (conflictingBooking) {
          throw new ConflictException(
            'One or more selected rooms are already reserved or temporarily held',
          );
        }

        const bookingRooms = [];
        let totalPrice = 0;

        const numberOfNights = Math.round(
          (checkOutDate.getTime() - checkInDate.getTime()) /
            (24 * 60 * 60 * 1000),
        );

        for (const selection of dto.rooms) {
          // Write to each selected room inside the transaction.
          const room = await this.roomModel
            .findOneAndUpdate(
              {
                _id: new Types.ObjectId(selection.roomId),
                hotelId: hotel._id,
                isActive: true,
              },
              { $inc: { __v: 1 } },
              { new: true, session },
            )
            .exec();

          if (!room) {
            throw new NotFoundException(
              `Room ${selection.roomId} was not found or is inactive`,
            );
          }

          const childrenAges = selection.childrenAges || [];
          const guestCount = selection.adults + childrenAges.length;

          if (guestCount < 1) {
            throw new BadRequestException(
              'Each selected room must have at least one guest',
            );
          }

          if (guestCount > room.maxOccupancy) {
            throw new BadRequestException(
              `Room ${room.name} exceeds its maximum occupancy of ${room.maxOccupancy}`,
            );
          }

          const availableForWholeStay =
            this.isStayCoveredByRanges(
              room.availabilityRanges || [],
              checkInDate,
              checkOutDate,
            );

          const overlapsBlockedRange = (
            room.blockedRanges || []
          ).some(
            (range) =>
              new Date(range.startDate).getTime() <
                checkOutDate.getTime() &&
              new Date(range.endDate).getTime() >
                checkInDate.getTime(),
          );

          if (!availableForWholeStay || overlapsBlockedRange) {
            throw new ConflictException(
              `Room ${room.name} is not available for the entire stay`,
            );
          }

          const roomTotal = room.pricePerNight * numberOfNights;
          totalPrice += roomTotal;

          bookingRooms.push({
            roomId: room._id,
            roomName: room.name,
            pricePerNight: room.pricePerNight,
            adults: selection.adults,
            childrenAges,
          });
        }

        const holdExpiresAt = new Date(
          now.getTime() + HOLD_DURATION_MS,
        );

        const booking = new this.bookingModel({
          userId: new Types.ObjectId(userId),
          hotelId: hotel._id,
          checkInDate,
          checkOutDate,
          rooms: bookingRooms,
          totalPrice: Number(totalPrice.toFixed(2)),
          status: HotelBookingStatus.PENDING_PAYMENT,
          holdExpiresAt,
          policiesAcceptedAt: now,
          checkInTime: hotel.checkInTime,
          checkOutTime: hotel.checkOutTime,
          cancellationTiers: hotel.cancellationTiers || [],
        });

        const saved = await booking.save({ session });
        createdBooking = saved.toObject();
      });

      return {
        message:
          'Rooms held successfully. Complete payment within 10 minutes.',
        booking: createdBooking,
      };
    } finally {
      await session.endSession();
    }
  }

  // HTL-20: Get the logged-in user's reservations,
  // grouped into Upcoming, Past, and Cancelled.
  async getMyBookings(userId: string) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }

    const bookings = await this.bookingModel
      .find({ userId: new Types.ObjectId(userId) })
      .populate(
        'hotelId',
        'name address cityId countryId photos',
      )
      .sort({ checkInDate: 1 })
      .lean()
      .exec();

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const upcoming = [];
    const past = [];
    const cancelled = [];

    for (const booking of bookings) {
      if (booking.status === HotelBookingStatus.CANCELLED) {
        cancelled.push(booking);
      } else if (
        booking.status === HotelBookingStatus.COMPLETED ||
        new Date(booking.checkOutDate) <= today
      ) {
        past.push(booking);
      } else {
        upcoming.push(booking);
      }
    }

    return {
      upcoming,
      past,
      cancelled,
    };
  }

  // HTL-20: Get the details of one reservation belonging to the user.
  async getBookingDetails(userId: string, bookingId: string) {
    if (
      !Types.ObjectId.isValid(userId) ||
      !Types.ObjectId.isValid(bookingId)
    ) {
      throw new BadRequestException('Invalid ID');
    }

    const booking = await this.bookingModel
      .findOne({
        _id: new Types.ObjectId(bookingId),
        userId: new Types.ObjectId(userId),
      })
      .populate(
        'hotelId',
        'name address cityId countryId photos',
      )
      .lean()
      .exec();

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }
    // HTL-22: Allow a hotel moderator to view reservations for their assigned hotel.
  async getHotelReservations(moderatorId: string) {
    if (!Types.ObjectId.isValid(moderatorId)) {
      throw new BadRequestException('Invalid moderator ID');
    }

    const moderator = await this.userModel
      .findById(moderatorId)
      .select('role hotelId')
      .exec();

    if (!moderator || moderator.role !== UserRole.MODERATOR) {
      throw new ForbiddenException(
        'Only hotel moderators can access these reservations',
      );
    }

    if (
      !moderator.hotelId ||
      !Types.ObjectId.isValid(String(moderator.hotelId))
    ) {
      throw new ForbiddenException(
        'No hotel is assigned to this moderator',
      );
    }

    const hotelId = new Types.ObjectId(String(moderator.hotelId));

    const reservations = await this.bookingModel
      .find({ hotelId })
      .populate('userId', 'email')
      .populate('hotelId', 'name')
      .sort({ checkInDate: 1, createdAt: -1 })
      .lean()
      .exec();

    return {
      hotelId,
      total: reservations.length,
      reservations,
    };
  }
  
}
