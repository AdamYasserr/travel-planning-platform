import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { ClientSession, Connection } from 'mongoose';
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
import { BOOKING_HOLD_DURATION_MS } from '../../common/booking/booking-hold';
import { runBookingTransaction } from '../../common/booking/booking-transaction';
import { ActiveBooking, activeBookingsFilter, findFreeRooms, isRoomOpenForStay } from '../hotels/room-availability';


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
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async create(userId: string, dto: CreateHotelBookingDto) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(dto.hotelId)) {
      throw new BadRequestException('Invalid user or hotel ID');
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
    const roomIds = dto.rooms.map((room) => new Types.ObjectId(room.roomId));
    if (new Set(roomIds.map(String)).size !== roomIds.length) {
      throw new BadRequestException('A room can only be booked once per reservation');
    }

    // HTL-18: availability check + hold are one atomic unit (see holdRooms).
    return runBookingTransaction(this.connection, (session) =>
      this.holdRooms(session, userId, dto, hotelId, roomIds, checkInDate, checkOutDate),
    );
  }

  /**
   * Runs inside a transaction. Either every selected room is held in ONE Pending Payment
   * reservation, or an exception aborts the transaction and nothing is written.
   */
  private async holdRooms(
    session: ClientSession,
    userId: string,
    dto: CreateHotelBookingDto,
    hotelId: Types.ObjectId,
    roomIds: Types.ObjectId[],
    checkInDate: Date,
    checkOutDate: Date,
  ) {
    const hotel = await this.hotelModel
      .findOne({ _id: hotelId, isActive: true })
      .session(session)
      .exec();
    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }

    const rooms = await this.roomModel
      .find({ _id: { $in: roomIds }, hotelId, isActive: true })
      .session(session)
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
    // The shared rule (hotels/room-availability.ts): the same one search and rooms/available use.
    const overlappingBookings = await this.bookingModel
      .find(activeBookingsFilter(roomIds, checkInDate, checkOutDate, now))
      .select({ rooms: 1, checkInDate: 1, checkOutDate: 1 })
      .session(session)
      .lean()
      .exec();
    const freeRoomIds = new Set(
      findFreeRooms(rooms, overlappingBookings as ActiveBooking[], checkInDate, checkOutDate).map((room) => room._id.toString()),
    );

    const roomById = new Map(rooms.map((room) => [room._id.toString(), room]));
    for (const request of dto.rooms) {
      const room = roomById.get(request.roomId.toLowerCase());
      if (!room) {
        throw new ConflictException('One or more selected rooms are unavailable');
      }
      const isFree = freeRoomIds.has(room._id.toString());
      // Reserved by someone else (the room itself is open for these dates).
      if (!isFree && isRoomOpenForStay(room, checkInDate, checkOutDate)) {
        throw new ConflictException('One or more selected rooms are unavailable');
      }
      if (request.adults + request.childrenAges.length > room.maxOccupancy) {
        throw new BadRequestException(`Guest count exceeds room capacity for ${room.name}`);
      }
      // Outside the bookable ranges, blocked or inactive.
      if (!isFree) {
        throw new ConflictException(`Room ${room.name} is not available for the selected dates`);
      }
    }

    // Write conflict point: any concurrent hold/block/availability change on one of these
    // rooms also bumps holdSeq, so exactly one of the overlapping transactions can commit.
    await this.roomModel
      .updateMany({ _id: { $in: roomIds } }, { $inc: { holdSeq: 1 } }, { session })
      .exec();

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

    const [booking] = await this.bookingModel.create(
      [
        {
          userId: new Types.ObjectId(userId),
          hotelId,
          checkInDate,
          checkOutDate,
          rooms: bookingRooms,
          totalPrice,
          currency,
          status: HotelBookingStatus.PENDING_PAYMENT,
          holdExpiresAt: new Date(now.getTime() + BOOKING_HOLD_DURATION_MS),
          reference: `HTL-${randomUUID()}`,
          policiesAcceptedAt: dto.policiesAccepted === true ? now : null,
          checkInTime: hotel.checkInTime,
          checkOutTime: hotel.checkOutTime,
          cancellationTiers: [...(hotel.cancellationTiers ?? [])]
            .sort((a, b) => b.daysBeforeCheckIn - a.daysBeforeCheckIn)
            .map((tier) => ({
              daysBeforeCheckIn: tier.daysBeforeCheckIn,
              refundPercentage: tier.refundPercentage,
            })),
        },
      ],
      { session },
    );
    return booking;
  }

  async listForUser(userId: string, page = 1, limit = 10) {
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
}
