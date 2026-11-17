import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
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
    reviews,
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

  const now = new Date();

  const bookings =
    rooms.length === 0
      ? []
      : await this.hotelBookingModel
          .find({
            'rooms.roomId': { $in: rooms.map((room) => room._id) },
            checkInDate: { $lt: endDate },
            checkOutDate: { $gt: startDate },
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

  const bookedRoomIds = new Set(
    bookings.flatMap((booking) =>
      booking.rooms.map((bookingRoom) => bookingRoom.roomId.toString()),
    ),
  );

  const availableRooms = rooms.filter((room) => {
    const roomId = room._id.toString();

    const overlapsBlockedRange = room.blockedRanges.some(
      (range) =>
        new Date(range.startDate).getTime() < endDate.getTime() &&
        new Date(range.endDate).getTime() > startDate.getTime(),
    );

    const availableForWholeRange = this.isStayCoveredByRanges(
      room.availabilityRanges,
      startDate,
      endDate,
    );

    return (
      !bookedRoomIds.has(roomId) &&
      !overlapsBlockedRange &&
      availableForWholeRange
    );
  });

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

  const room = await this.roomModel
    .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
    .exec();

  if (!room) {
    throw new NotFoundException('Room not found in this hotel');
  }

  const newRanges = dto.availabilityRanges.map((range) => ({
    startDate: new Date(`${range.startDate}T00:00:00.000Z`),
    endDate: new Date(`${range.endDate}T00:00:00.000Z`),
  }));

  const confirmedBookings = await this.hotelBookingModel
    .find({
      'rooms.roomId': roomObjectId,
      status: HotelBookingStatus.CONFIRMED,
    })
    .select({ checkInDate: 1, checkOutDate: 1 })
    .lean()
    .exec();

  const wouldRemoveConfirmedStay = confirmedBookings.some((booking) => {
    return !this.isStayCoveredByRanges(
      newRanges,
      booking.checkInDate,
      booking.checkOutDate,
    );
  });

  if (wouldRemoveConfirmedStay) {
    throw new ConflictException(
      'Availability cannot be removed for dates with a confirmed reservation',
    );
  }

  const updatedRoom = await this.roomModel
    .findOneAndUpdate(
      { _id: roomObjectId, hotelId: hotelObjectId },
      { $set: { availabilityRanges: newRanges } },
      { new: true, runValidators: true },
    )
    .exec();

  if (!updatedRoom) {
    throw new NotFoundException('Room not found in this hotel');
  }

  return updatedRoom;
}

private isStayCoveredByRanges(
  ranges: Array<{ startDate: Date; endDate: Date }>,
  checkInDate: Date,
  checkOutDate: Date,
): boolean {
  const sortedRanges = [...ranges].sort(
    (a, b) => a.startDate.getTime() - b.startDate.getTime(),
  );

  let coveredUntil = checkInDate.getTime();
  const requiredUntil = checkOutDate.getTime();

  for (const range of sortedRanges) {
    const start = range.startDate.getTime();
    const end = range.endDate.getTime();

    if (end <= coveredUntil) {
      continue;
    }

    if (start > coveredUntil) {
      return false;
    }

    coveredUntil = Math.max(coveredUntil, end);

    if (coveredUntil >= requiredUntil) {
      return true;
    }
  }

  return false;
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

  const room = await this.roomModel
    .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
    .exec();

  if (!room) {
    throw new NotFoundException('Room not found in this hotel');
  }

  const requestedRanges = dto.blockedRanges.map((range) => ({
    startDate: new Date(`${range.startDate}T00:00:00.000Z`),
    endDate: new Date(`${range.endDate}T00:00:00.000Z`),
  }));

  const now = new Date();
  const dateOverlapFilters = requestedRanges.map((range) => ({
    checkInDate: { $lt: range.endDate },
    checkOutDate: { $gt: range.startDate },
  }));

  const overlappingReservations = await this.hotelBookingModel
    .find({
      'rooms.roomId': roomObjectId,
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
      $and: [{ $or: dateOverlapFilters }],
    })
    .select({ _id: 1 })
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

    if (
      previous &&
      range.startDate.getTime() <= previous.endDate.getTime()
    ) {
      previous.endDate = new Date(
        Math.max(
          previous.endDate.getTime(),
          range.endDate.getTime(),
        ),
      );
    } else {
      mergedRanges.push({ ...range });
    }
  }

  const updatedRoom = await this.roomModel
    .findOneAndUpdate(
      { _id: roomObjectId, hotelId: hotelObjectId },
      { $set: { blockedRanges: mergedRanges } },
      { new: true, runValidators: true },
    )
    .exec();

  if (!updatedRoom) {
    throw new NotFoundException('Room not found in this hotel');
  }

  return updatedRoom;
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

  const room = await this.roomModel
    .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
    .exec();

  if (!room) {
    throw new NotFoundException('Room not found in this hotel');
  }

  const now = new Date();

  const activeReservation = await this.hotelBookingModel
    .findOne({
      'rooms.roomId': roomObjectId,
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
    .select({ _id: 1 })
    .lean()
    .exec();

  if (activeReservation) {
    throw new ConflictException(
      'A room cannot be deactivated while it has a confirmed or active pending reservation',
    );
  }

  room.isActive = false;
  await room.save();

  return room;
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

  const room = await this.roomModel
    .findOne({ _id: roomObjectId, hotelId: hotelObjectId })
    .exec();

  if (!room) {
    throw new NotFoundException('Room not found in this hotel');
  }

  const reservation = await this.hotelBookingModel
    .findOne({ 'rooms.roomId': roomObjectId })
    .select({ _id: 1 })
    .lean()
    .exec();

  if (reservation) {
    throw new ConflictException(
      'A room cannot be deleted because it has been reserved',
    );
  }

  await this.roomModel.deleteOne({
    _id: roomObjectId,
    hotelId: hotelObjectId,
  }).exec();

  return {
    message: 'Room deleted successfully',
    roomId,
  };
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

  const roomIds = rooms.map((room) => room._id);
  const now = new Date();

  const bookings =
    roomIds.length === 0
      ? []
      : await this.hotelBookingModel
          .find({
            'rooms.roomId': { $in: roomIds },
            checkInDate: { $lt: endDate },
            checkOutDate: { $gt: startDate },
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
          .select({ reference: 1, rooms: 1 })
          .lean()
          .exec();

  return rooms.map((room) => {
    const booking = bookings.find((candidate) =>
      candidate.rooms.some(
        (bookingRoom) =>
          bookingRoom.roomId.toString() === room._id.toString(),
      ),
    );

    if (booking) {
      return {
        roomId: room._id,
        roomName: room.name,
        status: 'Booked',
        reservationReference: booking.reference ?? null,
      };
    }

    const overlapsBlockedRange = room.blockedRanges.some(
      (range) =>
        new Date(range.startDate).getTime() < endDate.getTime() &&
        new Date(range.endDate).getTime() > startDate.getTime(),
    );

    const availableForWholeRange = this.isStayCoveredByRanges(
      room.availabilityRanges,
      startDate,
      endDate,
    );

    if (!room.isActive || overlapsBlockedRange || !availableForWholeRange) {
      return {
        roomId: room._id,
        roomName: room.name,
        status: 'Blocked',
        reservationReference: null,
      };
    }

    return {
      roomId: room._id,
      roomName: room.name,
      status: 'Available',
      reservationReference: null,
    };
  });
}
}
