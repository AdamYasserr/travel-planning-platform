
import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  CabinInventory,
  CabinInventoryDocument,
} from './schemas/cabin-inventory.schema';

import {
  Flight,
  FlightStatus,
} from './schemas/flight.schema';

import { User } from '../../users/user.schema';
import { PlatformCurrencyService } from '../../common/currency/platform-currency.service';
import { UserRole } from '../../common/enums/user-role.enum';

import {
  CreateCabinInventoryDto,
  UpdateCabinInventoryDto,
} from './dto/cabin-inventory.dto';

@Injectable()
export class CabinInventoryService {
  constructor(
    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventoryDocument>,

    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    private readonly platformCurrency: PlatformCurrencyService,
  ) {}

  // Check airline management permissions
  private async checkPermission(
    userId: string,
    airlineId: string,
  ): Promise<void> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new ForbiddenException('Invalid user');
    }

    const user = await this.userModel
      .findById(userId)
      .exec();

    if (
      !user ||
      !user.isActive ||
      user.isSuspended ||
      user.deactivatedAt
    ) {
      throw new ForbiddenException(
        'Account unavailable',
      );
    }

    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (
      user.role !== UserRole.MODERATOR ||
      user.airlineId !== airlineId
    ) {
      throw new ForbiddenException(
        'You cannot manage inventory for this airline',
      );
    }
  }

  // FLT-04: Create initial cabin inventory
  async create(
    flightId: string,
    dto: CreateCabinInventoryDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(flightId)) {
      throw new BadRequestException(
        'Invalid flight ID',
      );
    }

    const flight = await this.flightModel
      .findById(flightId)
      .exec();

    if (!flight) {
      throw new NotFoundException(
        'Flight not found',
      );
    }

    await this.checkPermission(
      userId,
      flight.airlineId.toString(),
    );

    if (
      flight.status !== FlightStatus.SCHEDULED ||
      flight.departureTime <= new Date()
    ) {
      throw new ConflictException(
        'Inventory cannot be created for this flight',
      );
    }

    if (
      !Number.isInteger(dto.totalSeats) ||
      dto.totalSeats < 1
    ) {
      throw new BadRequestException(
        'Total seats must be a positive integer',
      );
    }

    if (
      !Number.isFinite(dto.price) ||
      dto.price <= 0
    ) {
      throw new BadRequestException(
        'Price must be greater than zero',
      );
    }

    if (
      !Number.isInteger(dto.freeBagsCount) ||
      dto.freeBagsCount < 0
    ) {
      throw new BadRequestException(
        'Free bags count must be a non-negative integer',
      );
    }

    if (
      !Number.isFinite(dto.maxWeightPerBagKg) ||
      dto.maxWeightPerBagKg <= 0
    ) {
      throw new BadRequestException(
        'Maximum weight per bag must be greater than zero',
      );
    }

    const currency = this.platformCurrency.resolve(dto.currency);

    const existing = await this.inventoryModel
      .findOne({
        flightId: new Types.ObjectId(flightId),
        cabinClass: dto.cabinClass,
      })
      .exec();

    if (existing) {
      throw new ConflictException(
        'Cabin inventory already exists for this class',
      );
    }

    try {
      return await this.inventoryModel.create({
        flightId: new Types.ObjectId(flightId),
        cabinClass: dto.cabinClass,
        totalSeats: dto.totalSeats,
        availableSeats: dto.totalSeats,
        price: dto.price,
        currency,
        freeBagsCount: dto.freeBagsCount,
        maxWeightPerBagKg: dto.maxWeightPerBagKg,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException(
          'Cabin inventory already exists for this class',
        );
      }

      throw error;
    }
  }

  // FLT-04: Retrieve cabin inventory
  async findByFlight(flightId: string) {
    if (!Types.ObjectId.isValid(flightId)) {
      throw new BadRequestException(
        'Invalid flight ID',
      );
    }

    const flight = await this.flightModel
      .findById(flightId)
      .exec();

    if (!flight) {
      throw new NotFoundException(
        'Flight not found',
      );
    }

    return this.inventoryModel
      .find({
        flightId: new Types.ObjectId(flightId),
      })
      .exec();
  }

  // FLT-04 / FLT-05: Update cabin inventory
  async update(
    flightId: string,
    cabinId: string,
    dto: UpdateCabinInventoryDto,
    userId: string,
  ) {
    if (
      !Types.ObjectId.isValid(flightId) ||
      !Types.ObjectId.isValid(cabinId)
    ) {
      throw new BadRequestException(
        'Invalid flight or cabin ID',
      );
    }

    const flight = await this.flightModel
      .findById(flightId)
      .exec();

    if (!flight) {
      throw new NotFoundException(
        'Flight not found',
      );
    }

    await this.checkPermission(
      userId,
      flight.airlineId.toString(),
    );

    if (
      flight.status !== FlightStatus.SCHEDULED ||
      flight.departureTime <= new Date()
    ) {
      throw new ConflictException(
        'Inventory cannot be updated for this flight',
      );
    }

    const cabinObjectId = new Types.ObjectId(cabinId);
    const flightObjectId = new Types.ObjectId(flightId);

    const cabin = await this.inventoryModel
      .findOne({
        _id: cabinObjectId,
        flightId: flightObjectId,
      })
      .exec();

    if (!cabin) {
      throw new NotFoundException(
        'Cabin inventory not found for this flight',
      );
    }

    if (
      dto.totalSeats === undefined &&
      dto.price === undefined &&
      dto.currency === undefined &&
      dto.freeBagsCount === undefined &&
      dto.maxWeightPerBagKg === undefined
    ) {
      throw new BadRequestException(
        'At least one field must be provided',
      );
    }

    if (
      dto.totalSeats !== undefined &&
      (!Number.isInteger(dto.totalSeats) ||
        dto.totalSeats < 1)
    ) {
      throw new BadRequestException(
        'Total seats must be a positive integer',
      );
    }

    if (
      dto.price !== undefined &&
      (!Number.isFinite(dto.price) ||
        dto.price <= 0)
    ) {
      throw new BadRequestException(
        'Price must be greater than zero',
      );
    }

    // PAY-04: only the platform currency is accepted (400 on `currency` otherwise).
    if (dto.currency !== undefined) this.platformCurrency.resolve(dto.currency);

    if (
      dto.freeBagsCount !== undefined &&
      (!Number.isInteger(dto.freeBagsCount) ||
        dto.freeBagsCount < 0)
    ) {
      throw new BadRequestException(
        'Free bags count must be a non-negative integer',
      );
    }

    if (
      dto.maxWeightPerBagKg !== undefined &&
      (!Number.isFinite(dto.maxWeightPerBagKg) ||
        dto.maxWeightPerBagKg <= 0)
    ) {
      throw new BadRequestException(
        'Maximum weight per bag must be greater than zero',
      );
    }

    // Build an atomic update pipeline.
    // Preserve the number of allocated seats.
    const setFields: Record<string, unknown> = {};

    if (dto.totalSeats !== undefined) {
      setFields.totalSeats = dto.totalSeats;

      setFields.availableSeats = {
        $add: [
          '$availableSeats',
          {
            $subtract: [
              dto.totalSeats,
              '$totalSeats',
            ],
          },
        ],
      };
    }

    if (dto.price !== undefined) {
      setFields.price = dto.price;
    }

    if (dto.currency !== undefined) {
      setFields.currency = this.platformCurrency.resolve(dto.currency);
    }

    // FLT-04: Update baggage allowances
    if (dto.freeBagsCount !== undefined) {
      setFields.freeBagsCount = dto.freeBagsCount;
    }

    if (dto.maxWeightPerBagKg !== undefined) {
      setFields.maxWeightPerBagKg =
        dto.maxWeightPerBagKg;
    }

    const filter: Record<string, unknown> = {
      _id: cabinObjectId,
      flightId: flightObjectId,
    };

    if (dto.totalSeats !== undefined) {
      filter.$expr = {
        $and: [
          {
            $gte: [
              '$availableSeats',
              {
                $subtract: [
                  '$totalSeats',
                  dto.totalSeats,
                ],
              },
            ],
          },
          {
            $gte: [
              '$totalSeats',
              '$availableSeats',
            ],
          },
        ],
      };
    }

    const updatedCabin = await this.inventoryModel
      .findOneAndUpdate(
        filter,
        [{ $set: setFields }],
        // Mongoose 9 refuses an aggregation-pipeline update unless this is set (it was a 500 before).
        { returnDocument: 'after', updatePipeline: true },
      )
      .exec();

    if (!updatedCabin) {
      throw new ConflictException(
        'Capacity cannot be reduced below allocated seats',
      );
    }

    return updatedCabin;
  }
}
