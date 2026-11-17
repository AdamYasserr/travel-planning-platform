import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { UserRole } from '../../common/enums/user-role.enum';
import { paged } from '../../common/pagination/pagination';
import { fieldErrors } from '../../common/pipes/validation.pipe';
import { presentAuthor } from '../../common/users/deleted-user';
import { User } from '../../users/user.schema';
import { HotelBooking } from '../hotel-bookings/schemas/hotel-booking.schema';
import { HotelReservationsQueryDto } from './dto/hotel-reservations.dto';
import { Hotel } from './schemas/hotel.schema';

/** HTL-22: a hotel's reservations, for that hotel's moderator or an admin. */
@Injectable()
export class HotelReservationsService {
  constructor(
    @InjectModel(Hotel.name) private readonly hotels: Model<Hotel>,
    @InjectModel(HotelBooking.name) private readonly bookings: Model<HotelBooking>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  async list(viewer: { userId: string; role?: string }, hotelId: string, query: HotelReservationsQueryDto) {
    if (!Types.ObjectId.isValid(hotelId)) throw new BadRequestException('Invalid hotel ID');
    if (query.from && query.to && query.from > query.to) {
      throw fieldErrors([{ field: 'to', messages: ['to must be on or after from'] }]);
    }
    await this.assertCanView(viewer, hotelId);

    const filter: Record<string, unknown> = { hotelId: new Types.ObjectId(hotelId) };
    if (query.status) filter.status = query.status;
    // A stay overlaps [from, to] when it starts on or before `to` and ends on or after `from`.
    if (query.to) filter.checkInDate = { $lte: new Date(`${query.to}T00:00:00.000Z`) };
    if (query.from) filter.checkOutDate = { $gte: new Date(`${query.from}T00:00:00.000Z`) };

    const [rows, total] = await Promise.all([
      this.bookings
        .find(filter as never)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<(HotelBooking & { _id: Types.ObjectId; createdAt: Date })[]>()
        .exec(),
      this.bookings.countDocuments(filter as never).exec(),
    ]);
    const guests = rows.length
      ? await this.users.find({ _id: { $in: rows.map((r) => r.userId) } }).select('_id name isActive deactivatedAt').lean().exec()
      : [];
    const guestById = new Map(guests.map((g) => [String(g._id), g]));
    const items = rows.map((r) => ({
      bookingId: String(r._id),
      reference: r.reference ?? null,
      guest: { name: presentAuthor(guestById.get(String(r.userId)) as never).name },
      rooms: r.rooms.map((room) => ({ roomId: String(room.roomId), roomName: room.roomName })),
      checkInDate: r.checkInDate,
      checkOutDate: r.checkOutDate,
      status: r.status,
      totalPrice: r.totalPrice,
      currency: r.currency,
      bookedAt: r.createdAt,
    }));
    return paged(items, total, query.page, query.limit);
  }

  private async assertCanView(viewer: { userId: string; role?: string }, hotelId: string) {
    const hotel = await this.hotels.findById(hotelId).select('_id').lean().exec();
    if (!hotel) throw new NotFoundException('Hotel not found');
    if (viewer.role === UserRole.ADMIN) return;
    const user = await this.users.findById(viewer.userId).select('role hotelId').lean().exec();
    const assigned = user?.hotelId && Types.ObjectId.isValid(user.hotelId) ? new Types.ObjectId(user.hotelId).toString() : null;
    if (!user || user.role !== UserRole.MODERATOR || assigned !== hotelId.toLowerCase()) {
      throw new ForbiddenException('You can only view reservations of the hotel assigned to your account');
    }
  }
}
