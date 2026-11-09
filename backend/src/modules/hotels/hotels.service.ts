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
} from './dto/hotels.dto';
import { Hotel } from './schemas/hotel.schema';
import { Room } from './schemas/room.schema';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

@Injectable()
export class HotelsService {
  constructor(
    @InjectModel(Hotel.name)
    private readonly hotelModel: Model<Hotel>,
    @InjectModel(User.name)
    private readonly userModel: Model<User>,
    @InjectModel(Room.name)
    private readonly roomModel: Model<Room>,
  ) {}

  async create(dto: CreateHotelDto) {
    if (
      !Types.ObjectId.isValid(dto.cityId) ||
      !Types.ObjectId.isValid(dto.countryId)
    ) {
      throw new BadRequestException('Invalid city or country ID');
    }

    return this.hotelModel.create({
      ...dto,
      cityId: new Types.ObjectId(dto.cityId),
      countryId: new Types.ObjectId(dto.countryId),
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

    if (dto.cityId) {
      updateData.cityId = new Types.ObjectId(dto.cityId);
    }

    if (dto.countryId) {
      updateData.countryId = new Types.ObjectId(dto.countryId);
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

async getDetails(hotelId: string) {
  if (!Types.ObjectId.isValid(hotelId)) {
    throw new BadRequestException('Invalid hotel ID');
  }

  const hotel = await this.hotelModel
    .findOne({
      _id: new Types.ObjectId(hotelId),
      isActive: true,
    })
    .exec();

  if (!hotel) {
    throw new NotFoundException('Hotel not found');
  }

  return hotel;
}
}