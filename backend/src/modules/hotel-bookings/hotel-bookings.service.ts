import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import {
  CreateHotelBookingDto,
  HotelBookingRoomRequestDto,
} from './dto/hotel-bookings.dto';
import {
  HotelBooking,
  HotelBookingStatus,
} from './schemas/hotel-booking.schema';
import { Hotel } from '../hotels/schemas/hotel.schema';
import { Room } from '../hotels/schemas/room.schema';
import { PaymentsService } from '../payments/payments.service';
import { PaymentBookingType } from '../payments/enums/payment-status.enum';

const HOLD_DURATION_MS = 15 * 60 * 1000;

@Injectable()
export class HotelBookingsService {
  constructor(
    @InjectModel(HotelBooking.name)
    private readonly bookingModel: Model<HotelBooking>,
    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<Hotel>,
    @InjectModel(Room.name)
    private readonly roomModel: Model<Room>,
    private readonly paymentsService: PaymentsService,
  ) {}

  async create(userId: string, dto: CreateHotelBookingDto) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(dto.hotelId)) {
      throw new BadRequestException('Invalid user or hotel ID');
    }
    if (dto.policiesAccepted !== true) {
      throw new BadRequestException('You must accept the hotel booking policies');
    }

    const checkInDate = this.parseDate(dto.checkInDate);
    const checkOutDate = this.parseDate(dto.checkOutDate);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (
      checkInDate < today ||
      checkOutDate <= checkInDate ||
      checkInDate.getTime() !== this.utcDay(checkInDate).getTime() ||
      checkOutDate.getTime() !== this.utcDay(checkOutDate).getTime()
    ) {
      throw new BadRequestException(
        'Check-in must be today or later and check-out must be after check-in',
      );
    }

    this.validateGuests(dto.rooms);

    const hotelId = new Types.ObjectId(dto.hotelId);
    const hotel = await this.hotelModel
      .findOne({ _id: hotelId, isActive: true })
      .exec();
    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }

    const roomIds = dto.rooms.map((room) => new Types.ObjectId(room.roomId));
    if (new Set(roomIds.map(String)).size !== roomIds.length) {
      throw new BadRequestException('A room can only be booked once per reservation');
    }

    const rooms = await this.roomModel
      .find({ _id: { $in: roomIds }, hotelId, isActive: true })
      .exec();
    if (rooms.length !== roomIds.length) {
      throw new ConflictException('One or more selected rooms are unavailable');
    }
    if (
      rooms.some((room) => !room.currency) ||
      new Set(rooms.map((room) => room.currency.toUpperCase())).size !== 1
    ) {
      throw new BadRequestException(
        'Selected rooms must have a configured matching currency',
      );
    }
    const currency = rooms[0].currency.toUpperCase();

    const now = new Date();
    const overlappingBookings = await this.bookingModel
      .find({
        'rooms.roomId': { $in: roomIds },
        checkInDate: { $lt: checkOutDate },
        checkOutDate: { $gt: checkInDate },
        $or: [
          { status: HotelBookingStatus.CONFIRMED },
          {
            status: HotelBookingStatus.PENDING_PAYMENT,
            holdExpiresAt: { $gt: now },
          },
          {
            status: HotelBookingStatus.PENDING_PAYMENT,
            holdExpiresAt: null,
          },
        ],
      })
      .select({ rooms: 1 })
      .lean()
      .exec();
    const reservedRoomIds = new Set(
      overlappingBookings.flatMap((booking) =>
        booking.rooms.map((bookingRoom) => bookingRoom.roomId.toString()),
      ),
    );

    const roomById = new Map(rooms.map((room) => [room._id.toString(), room]));
    for (const request of dto.rooms) {
      const room = roomById.get(request.roomId.toLowerCase());
      if (!room || reservedRoomIds.has(request.roomId.toLowerCase())) {
        throw new ConflictException('One or more selected rooms are unavailable');
      }
      if (request.adults + request.childrenAges.length > room.maxOccupancy) {
        throw new BadRequestException(`Guest count exceeds room capacity for ${room.name}`);
      }
      if (
        !this.isStayCovered(room.availabilityRanges, checkInDate, checkOutDate) ||
        room.blockedRanges.some(
          (range) =>
            new Date(range.startDate).getTime() < checkOutDate.getTime() &&
            new Date(range.endDate).getTime() > checkInDate.getTime(),
        )
      ) {
        throw new ConflictException(`Room ${room.name} is not available for the selected dates`);
      }
    }

    const nightCount =
      (checkOutDate.getTime() - checkInDate.getTime()) / 86_400_000;
    const bookingRooms = dto.rooms.map((request) => {
      const room = roomById.get(request.roomId.toLowerCase())!;
      return {
        roomId: room._id,
        roomName: room.name,
        pricePerNight: room.pricePerNight,
        currency: room.currency.toUpperCase(),
        adults: request.adults,
        childrenAges: request.childrenAges ?? [],
      };
    });
    const totalPrice = bookingRooms.reduce(
      (total, room) => total + room.pricePerNight * nightCount,
      0,
    );

    return this.bookingModel.create({
      userId: new Types.ObjectId(userId),
      hotelId,
      checkInDate,
      checkOutDate,
      rooms: bookingRooms,
      totalPrice,
      currency,
      status: HotelBookingStatus.PENDING_PAYMENT,
      holdExpiresAt: new Date(now.getTime() + HOLD_DURATION_MS),
      reference: `HTL-${randomUUID()}`,
      policiesAcceptedAt: now,
      checkInTime: hotel.checkInTime,
      checkOutTime: hotel.checkOutTime,
      cancellationTiers: [...(hotel.cancellationTiers ?? [])]
        .sort((a, b) => b.daysBeforeCheckIn - a.daysBeforeCheckIn)
        .map((tier) => ({
          daysBeforeCheckIn: tier.daysBeforeCheckIn,
          refundPercentage: tier.refundPercentage,
        })),
    });
  }

  async listForUser(userId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const filter = { userId: new Types.ObjectId(userId) };
    const [items, totalItems] = await Promise.all([
      this.bookingModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.bookingModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getForUser(userId: string, bookingId: string) {
    if (!Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid booking ID');
    }
    const booking = await this.bookingModel
      .findOne({ _id: bookingId, userId })
      .populate('hotelId')
      .exec();
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  async cancel(userId: string, bookingId: string) {
    return this.paymentsService.cancelBooking(
      userId,
      PaymentBookingType.HOTEL,
      bookingId,
    );
  }

  private parseDate(value: string): Date {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime())) {
      throw new BadRequestException('Invalid booking date');
    }
    return parsed;
  }

  private utcDay(date: Date): Date {
    const day = new Date(date);
    day.setUTCHours(0, 0, 0, 0);
    return day;
  }

  private validateGuests(rooms: HotelBookingRoomRequestDto[]) {
    if (!rooms.some((room) => room.adults > 0)) {
      throw new BadRequestException('A reservation must include at least one adult');
    }
    if (rooms.some((room) => room.adults + room.childrenAges.length < 1)) {
      throw new BadRequestException('Each room must include at least one guest');
    }
  }

  private isStayCovered(
    ranges: Array<{ startDate: Date; endDate: Date }>,
    checkIn: Date,
    checkOut: Date,
  ): boolean {
    const sortedRanges = [...ranges].sort(
      (a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
    );
    let coveredUntil = checkIn.getTime();
    for (const range of sortedRanges) {
      const start = new Date(range.startDate).getTime();
      const end = new Date(range.endDate).getTime();
      if (end <= coveredUntil) continue;
      if (start > coveredUntil) return false;
      coveredUntil = end;
      if (coveredUntil >= checkOut.getTime()) return true;
    }
    return false;
  }

}
