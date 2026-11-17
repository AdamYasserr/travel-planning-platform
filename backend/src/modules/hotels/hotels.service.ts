import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { Model, Types } from 'mongoose';

import {
  CreateHotelDto,
  CreateRoomDto,
  UpdateHotelDto,
  UpdateRoomDto,
  SetRoomAvailabilityDto,
  BlockRoomDto,
  RoomStatusQueryDto,
  HotelDetailsQueryDto,
} from './dto/hotels.dto';
import { Hotel } from './schemas/hotel.schema';
import { Room } from './schemas/room.schema';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { Review } from './schemas/review.schema';
import { ReferenceValidationService } from '../reference-data/reference-validation.service';
import { SupportedCurrenciesService } from '../reference-data/supported-currencies.service';
import { presentAuthor } from '../../common/users/deleted-user';
import { runBookingTransaction } from '../../common/booking/booking-transaction';
import { activeReservationClause } from '../hotel-bookings/room-reservation.util';
import {
  ActiveBooking,
  activeBookingsFilter,
  bookingsForRoom,
  findFreeRooms,
  isStayCoveredByRanges,
} from './room-availability';
import {
  HotelBooking,
  HotelBookingStatus,
} from '../hotel-bookings/schemas/hotel-booking.schema';

@Injectable()
export class HotelsService {
  constructor(
    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<Hotel>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(Room.name)
    private readonly roomModel: Model<Room>,
    @InjectModel(HotelBooking.name)
    private readonly hotelBookingModel: Model<HotelBooking>,
    @InjectModel(Review.name)
    private readonly reviewModel: Model<Review>,
    private readonly references: ReferenceValidationService,
    private readonly currencies: SupportedCurrenciesService,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async create(dto: CreateHotelDto) {
    // cityId is a dataset city_id (e.g. "cairo"); countryId is a dataset country code (e.g. "EG").
    const cityId = dto.cityId.trim();
    const countryId = dto.countryId.trim().toUpperCase();
    await this.references.assertCityInCountry(cityId, countryId);

    return this.hotelModel.create({
      ...dto,
      cityId,
      countryId,
      isActive: true,
    });
  }

  async update(
    hotelId: string,
    dto: UpdateHotelDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(hotelId)) {
      throw new BadRequestException('Invalid hotel ID');
    }

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        'Provide at least one hotel field to update',
      );
    }

    const user = await this.userModel.findById(userId).exec();
    const normalizedHotelId = new Types.ObjectId(hotelId).toString();

    const assignedHotelId =
      user?.hotelId && Types.ObjectId.isValid(user.hotelId)
        ? new Types.ObjectId(user.hotelId).toString()
        : null;

    if (
      !user ||
      user.role !== UserRole.MODERATOR ||
      assignedHotelId !== normalizedHotelId
    ) {
      throw new ForbiddenException(
        'You can only edit the hotel assigned to your account',
      );
    }

    const updateData: Partial<Hotel> = {
      ...dto,
    } as Partial<Hotel>;

    if (dto.cityId || dto.countryId) {
      const existing = await this.hotelModel.findById(normalizedHotelId).exec();
      if (!existing) {
        throw new NotFoundException('Hotel not found');
      }
      const cityId = (dto.cityId ?? existing.cityId).trim();
      const countryId = (dto.countryId ?? existing.countryId).trim().toUpperCase();
      await this.references.assertCityInCountry(cityId, countryId);
      updateData.cityId = cityId;
      updateData.countryId = countryId;
    }

    const updatedHotel = await this.hotelModel
      .findByIdAndUpdate(
        normalizedHotelId,
        { $set: updateData },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updatedHotel) {
      throw new NotFoundException('Hotel not found');
    }

    return updatedHotel;
  }

  async updateRoom(
    hotelId: string,
    roomId: string,
    dto: UpdateRoomDto,
    userId: string,
  ) {
    if (
      !Types.ObjectId.isValid(hotelId) ||
      !Types.ObjectId.isValid(roomId)
    ) {
      throw new BadRequestException('Invalid hotel or room ID');
    }

    if (Object.keys(dto).length === 0) {
      throw new BadRequestException(
        'Provide at least one room field to update',
      );
    }

    const normalizedHotelId = new Types.ObjectId(hotelId).toString();
    const user = await this.userModel.findById(userId).exec();

    const assignedHotelId =
      user?.hotelId && Types.ObjectId.isValid(user.hotelId)
        ? new Types.ObjectId(user.hotelId).toString()
        : null;

    if (
      !user ||
      user.role !== UserRole.MODERATOR ||
      assignedHotelId !== normalizedHotelId
    ) {
      throw new ForbiddenException(
        'You can only update rooms in the hotel assigned to your account',
      );
    }

    if (dto.currency !== undefined) {
      dto.currency = await this.currencies.assertSupported(dto.currency, 'currency');
    }

    const updatedRoom = await this.roomModel
      .findOneAndUpdate(
        {
          _id: new Types.ObjectId(roomId),
          hotelId: new Types.ObjectId(normalizedHotelId),
        },
        { $set: dto },
        { new: true, runValidators: true },
      )
      .exec();

    if (!updatedRoom) {
      throw new NotFoundException('Room not found in this hotel');
    }

    return updatedRoom;
  }

  async createRoom(
    hotelId: string,
    dto: CreateRoomDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(hotelId)) {
      throw new BadRequestException('Invalid hotel ID');
    }

    const normalizedHotelId = new Types.ObjectId(hotelId).toString();
    const user = await this.userModel.findById(userId).exec();

    const assignedHotelId =
      user?.hotelId && Types.ObjectId.isValid(user.hotelId)
        ? new Types.ObjectId(user.hotelId).toString()
        : null;

    if (
      !user ||
      user.role !== UserRole.MODERATOR ||
      assignedHotelId !== normalizedHotelId
    ) {
      throw new ForbiddenException(
        'You can only add rooms to the hotel assigned to your account',
      );
    }

    dto.currency = await this.currencies.assertSupported(dto.currency, 'currency');

    const hotel = await this.hotelModel.findById(normalizedHotelId).exec();

    if (!hotel) {
      throw new NotFoundException('Hotel not found');
    }

    const availabilityRanges =
      dto.availabilityRanges?.map((range) => ({
        startDate: new Date(`${range.startDate}T00:00:00.000Z`),
        endDate: new Date(`${range.endDate}T00:00:00.000Z`),
      })) ?? [];

    try {
      return await this.roomModel.create({
        ...dto,
        hotelId: new Types.ObjectId(normalizedHotelId),
        availabilityRanges,
        isActive: true,
      });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === 11000
      ) {
        throw new ConflictException(
          'A room with this name already exists in this hotel',
        );
      }

      throw error;
    }
  }

  async listRooms(
  hotelId: string,
  page: number,
  userId: string,
) {
  if (!Types.ObjectId.isValid(hotelId)) {
    throw new BadRequestException('Invalid hotel ID');
  }

  const normalizedHotelId = new Types.ObjectId(hotelId).toString();
  const user = await this.userModel.findById(userId).exec();

  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== normalizedHotelId
  ) {
    throw new ForbiddenException(
      'You can only view rooms for the hotel assigned to your account',
    );
  }

  const hotel = await this.hotelModel.findById(normalizedHotelId).exec();

  if (!hotel) {
    throw new NotFoundException('Hotel not found');
  }

  const pageSize = 10;
  const filter = {
    hotelId: new Types.ObjectId(normalizedHotelId),
  };

  const [items, totalItems] = await Promise.all([
    this.roomModel
      .find(filter)
      .sort({ name: 1, _id: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .exec(),
    this.roomModel.countDocuments(filter).exec(),
  ]);

  const totalPages = Math.ceil(totalItems / pageSize);

  return {
    items,
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && totalPages > 0,
    },
  };
}

/**
 * Recomputes the stored averageRating / ratingCount of a hotel from its visible reviews (HTL-12 search uses the
 * stored values). Called by whatever creates, edits, hides or deletes a review (the reviews task).
 */
async refreshRating(hotelId: string | Types.ObjectId) {
  const [row] = await this.reviewModel
    .aggregate([
      { $match: { hotelId: new Types.ObjectId(String(hotelId)), isHidden: { $ne: true } } },
      { $group: { _id: null, average: { $avg: '$rating' }, count: { $sum: 1 } } },
    ])
    .exec();
  const averageRating = row ? Number(row.average.toFixed(2)) : null;
  const ratingCount = row?.count ?? 0;
  await this.hotelModel.updateOne({ _id: new Types.ObjectId(String(hotelId)) }, { $set: { averageRating, ratingCount } }).exec();
  return { averageRating, ratingCount };
}

async getDetails(
  hotelId: string,
  query: HotelDetailsQueryDto,
) {
  if (!Types.ObjectId.isValid(hotelId)) {
    throw new BadRequestException('Invalid hotel ID');
  }

  const hotelObjectId = new Types.ObjectId(hotelId);

  const hotel = await this.hotelModel
    .findOne({ _id: hotelObjectId, isActive: true })
    .exec();

  if (!hotel) {
    throw new NotFoundException('Hotel not found');
  }

  const reviews = await this.reviewModel
    .find({ hotelId: hotelObjectId, isHidden: { $ne: true } })
    .sort({ createdAt: -1 })
    .lean()
    .exec();

  // ACC-12: reviews written by deactivated accounts are shown as "Deleted user".
  const reviewers = reviews.length
    ? await this.userModel
        .find({ _id: { $in: reviews.map((review) => review.userId) } })
        .select('_id name isActive deactivatedAt')
        .lean()
        .exec()
    : [];
  const reviewerById = new Map(reviewers.map((reviewer) => [reviewer._id.toString(), reviewer]));
  const presentedReviews = reviews.map((review) => {
    const reviewer = reviewerById.get(String(review.userId));
    return { ...review, author: { name: presentAuthor(reviewer).name } };
  });

  const averageRating =
    reviews.length === 0
      ? null
      : Number(
          (
            reviews.reduce((total, review) => total + review.rating, 0) /
            reviews.length
          ).toFixed(2),
        );

  const details = {
    ...hotel.toObject(),
    averageRating,
    reviews: presentedReviews,
  };

  if (!query.checkInDate || !query.checkOutDate) {
    return details;
  }

  const startDate = new Date(`${query.checkInDate}T00:00:00.000Z`);
  const endDate = new Date(`${query.checkOutDate}T00:00:00.000Z`);

  const rooms = await this.roomModel
    .find({ hotelId: hotelObjectId, isActive: true })
    .sort({ name: 1, _id: 1 })
    .exec();

  // The shared rule (room-availability.ts): the same one search, rooms/available and the booking hold use.
  const activeBookings = rooms.length === 0
    ? []
    : await this.hotelBookingModel
        .find(activeBookingsFilter(rooms.map((room) => room._id), startDate, endDate, new Date()))
        .select({ rooms: 1, checkInDate: 1, checkOutDate: 1 })
        .lean()
        .exec();

  const availableRooms = findFreeRooms(rooms, activeBookings as ActiveBooking[], startDate, endDate);

  return {
    ...details,
    availableRooms,
  };
}

async setRoomAvailability(
  hotelId: string,
  roomId: string,
  dto: SetRoomAvailabilityDto,
  userId: string,
) {
  if (
    !Types.ObjectId.isValid(hotelId) ||
    !Types.ObjectId.isValid(roomId)
  ) {
    throw new BadRequestException('Invalid hotel or room ID');
  }

  const normalizedHotelId = new Types.ObjectId(hotelId).toString();
  const user = await this.userModel.findById(userId).exec();

  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== normalizedHotelId
  ) {
    throw new ForbiddenException(
      'You can only update availability for rooms in your assigned hotel',
    );
  }

  const roomObjectId = new Types.ObjectId(roomId);
  const hotelObjectId = new Types.ObjectId(normalizedHotelId);

  const newRanges = dto.availabilityRanges.map((range) => ({
    startDate: new Date(`${range.startDate}T00:00:00.000Z`),
    endDate: new Date(`${range.endDate}T00:00:00.000Z`),
  }));

  return runBookingTransaction(this.connection, async (session) => {
    const room = await this.roomModel
      .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
      .session(session)
      .exec();

    if (!room) {
      throw new NotFoundException('Room not found in this hotel');
    }

    // Confirmed stays and unexpired holds must remain fully covered by the new ranges.
    const activeBookings = await this.hotelBookingModel
      .find({
        'rooms.roomId': roomObjectId,
        $or: activeReservationClause(new Date()),
      })
      .select({ checkInDate: 1, checkOutDate: 1 })
      .session(session)
      .lean()
      .exec();

    const wouldRemoveReservedStay = activeBookings.some(
      (booking) =>
        !isStayCoveredByRanges(
          newRanges,
          booking.checkInDate,
          booking.checkOutDate,
        ),
    );

    if (wouldRemoveReservedStay) {
      throw new ConflictException(
        'Availability cannot be removed for dates with a confirmed or active pending reservation',
      );
    }

    const updatedRoom = await this.roomModel
      .findOneAndUpdate(
        { _id: roomObjectId, hotelId: hotelObjectId },
        { $set: { availabilityRanges: newRanges }, $inc: { holdSeq: 1 } },
        { new: true, runValidators: true, session },
      )
      .exec();

    if (!updatedRoom) {
      throw new NotFoundException('Room not found in this hotel');
    }

    return updatedRoom;
  });
}

async blockRoomDates(
  hotelId: string,
  roomId: string,
  dto: BlockRoomDto,
  userId: string,
) {
  if (
    !Types.ObjectId.isValid(hotelId) ||
    !Types.ObjectId.isValid(roomId)
  ) {
    throw new BadRequestException('Invalid hotel or room ID');
  }

  const normalizedHotelId = new Types.ObjectId(hotelId).toString();
  const user = await this.userModel.findById(userId).exec();

  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== normalizedHotelId
  ) {
    throw new ForbiddenException(
      'You can only block rooms in the hotel assigned to your account',
    );
  }

  const hotelObjectId = new Types.ObjectId(normalizedHotelId);
  const roomObjectId = new Types.ObjectId(roomId);

  const requestedRanges = dto.blockedRanges.map((range) => ({
    startDate: new Date(`${range.startDate}T00:00:00.000Z`),
    endDate: new Date(`${range.endDate}T00:00:00.000Z`),
  }));

  // HTL-18: check + write in one transaction that also bumps holdSeq, so it cannot race with a hold.
  return runBookingTransaction(this.connection, async (session) => {
    const room = await this.roomModel
      .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
      .session(session)
      .exec();

    if (!room) {
      throw new NotFoundException('Room not found in this hotel');
    }

    const dateOverlapFilters = requestedRanges.map((range) => ({
      checkInDate: { $lt: range.endDate },
      checkOutDate: { $gt: range.startDate },
    }));

    const overlappingReservations = await this.hotelBookingModel
      .find({
        'rooms.roomId': roomObjectId,
        $or: activeReservationClause(new Date()),
        $and: [{ $or: dateOverlapFilters }],
      })
      .select({ _id: 1 })
      .session(session)
      .lean()
      .exec();

    if (overlappingReservations.length > 0) {
      throw new ConflictException(
        'Room dates cannot be blocked while an active reservation overlaps them',
      );
    }

    const combinedRanges = [
      ...room.blockedRanges.map((range) => ({
        startDate: new Date(range.startDate),
        endDate: new Date(range.endDate),
      })),
      ...requestedRanges,
    ].sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

    const mergedRanges: Array<{ startDate: Date; endDate: Date }> = [];

    for (const range of combinedRanges) {
      const previous = mergedRanges[mergedRanges.length - 1];

      if (previous && range.startDate.getTime() <= previous.endDate.getTime()) {
        previous.endDate = new Date(
          Math.max(previous.endDate.getTime(), range.endDate.getTime()),
        );
      } else {
        mergedRanges.push({ ...range });
      }
    }

    const updatedRoom = await this.roomModel
      .findOneAndUpdate(
        { _id: roomObjectId, hotelId: hotelObjectId },
        { $set: { blockedRanges: mergedRanges }, $inc: { holdSeq: 1 } },
        { new: true, runValidators: true, session },
      )
      .exec();

    if (!updatedRoom) {
      throw new NotFoundException('Room not found in this hotel');
    }

    return updatedRoom;
  });
}

async deactivateRoom(
  hotelId: string,
  roomId: string,
  userId: string,
) {
  if (
    !Types.ObjectId.isValid(hotelId) ||
    !Types.ObjectId.isValid(roomId)
  ) {
    throw new BadRequestException('Invalid hotel or room ID');
  }

  const hotelObjectId = new Types.ObjectId(hotelId);
  const roomObjectId = new Types.ObjectId(roomId);

  const user = await this.userModel.findById(userId).exec();
  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== hotelObjectId.toString()
  ) {
    throw new ForbiddenException(
      'You can only deactivate rooms in the hotel assigned to your account',
    );
  }

  return runBookingTransaction(this.connection, async (session) => {
    const room = await this.roomModel
      .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
      .session(session)
      .exec();

    if (!room) {
      throw new NotFoundException('Room not found in this hotel');
    }

    const activeReservation = await this.hotelBookingModel
      .findOne({
        'rooms.roomId': roomObjectId,
        $or: activeReservationClause(new Date()),
      })
      .select({ _id: 1 })
      .session(session)
      .lean()
      .exec();

    if (activeReservation) {
      throw new ConflictException(
        'A room cannot be deactivated while it has a confirmed or active pending reservation',
      );
    }

    return this.roomModel
      .findOneAndUpdate(
        { _id: roomObjectId, hotelId: hotelObjectId },
        { $set: { isActive: false }, $inc: { holdSeq: 1 } },
        { new: true, session },
      )
      .exec();
  });
}

async deleteRoom(
  hotelId: string,
  roomId: string,
  userId: string,
) {
  if (
    !Types.ObjectId.isValid(hotelId) ||
    !Types.ObjectId.isValid(roomId)
  ) {
    throw new BadRequestException('Invalid hotel or room ID');
  }

  const hotelObjectId = new Types.ObjectId(hotelId);
  const roomObjectId = new Types.ObjectId(roomId);

  const user = await this.userModel.findById(userId).exec();
  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== hotelObjectId.toString()
  ) {
    throw new ForbiddenException(
      'You can only delete rooms in the hotel assigned to your account',
    );
  }

  return runBookingTransaction(this.connection, async (session) => {
    const room = await this.roomModel
      .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
      .session(session)
      .exec();

    if (!room) {
      throw new NotFoundException('Room not found in this hotel');
    }

    const reservation = await this.hotelBookingModel
      .findOne({ 'rooms.roomId': roomObjectId })
      .select({ _id: 1 })
      .session(session)
      .lean()
      .exec();

    if (reservation) {
      throw new ConflictException(
        'A room cannot be deleted because it has been reserved',
      );
    }

    // The delete writes the room document, so it conflicts with a concurrent hold's holdSeq bump.
    await this.roomModel
      .deleteOne({ _id: roomObjectId, hotelId: hotelObjectId }, { session })
      .exec();

    return {
      message: 'Room deleted successfully',
      roomId,
    };
  });
}

async getRoomStatuses(
  hotelId: string,
  query: RoomStatusQueryDto,
  userId: string,
) {
  if (!Types.ObjectId.isValid(hotelId)) {
    throw new BadRequestException('Invalid hotel ID');
  }

  const hotelObjectId = new Types.ObjectId(hotelId);
  const user = await this.userModel.findById(userId).exec();

  const assignedHotelId =
    user?.hotelId && Types.ObjectId.isValid(user.hotelId)
      ? new Types.ObjectId(user.hotelId).toString()
      : null;

  if (
    !user ||
    user.role !== UserRole.MODERATOR ||
    assignedHotelId !== hotelObjectId.toString()
  ) {
    throw new ForbiddenException(
      'You can only view room statuses for the hotel assigned to your account',
    );
  }

  const hotel = await this.hotelModel.findById(hotelObjectId).exec();

  if (!hotel) {
    throw new NotFoundException('Hotel not found');
  }

  const startDate = new Date(`${query.startDate}T00:00:00.000Z`);
  const endDate = new Date(`${query.endDate}T00:00:00.000Z`);

  const rooms = await this.roomModel
    .find({ hotelId: hotelObjectId })
    .sort({ name: 1, _id: 1 })
    .exec();

  // Same rule as search and booking: Booked = an active reservation overlaps; Available = free; else Blocked.
  const activeBookings: Array<ActiveBooking & { reference?: string; status?: string }> =
    rooms.length === 0
      ? []
      : ((await this.hotelBookingModel
          .find(activeBookingsFilter(rooms.map((room) => room._id), startDate, endDate, new Date()))
          .select({ reference: 1, status: 1, rooms: 1, checkInDate: 1, checkOutDate: 1 })
          .lean()
          .exec()) as never);
  const freeIds = new Set(findFreeRooms(rooms, activeBookings, startDate, endDate).map((room) => String(room._id)));

  return rooms.map((room) => {
    const [booking] = bookingsForRoom(activeBookings, room._id);

    if (booking) {
      return {
        roomId: room._id,
        roomName: room.name,
        status: 'Booked',
        reservationReference: booking.reference ?? null,
        reservationStatus: booking.status ?? null,
      };
    }

    return {
      roomId: room._id,
      roomName: room.name,
      status: freeIds.has(String(room._id)) ? 'Available' : 'Blocked',
      reservationReference: null,
      reservationStatus: null,
    };
  });
}
}
