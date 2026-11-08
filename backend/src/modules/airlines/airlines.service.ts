
import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Airline } from './schemas/airline.schema';
import { BaggagePolicy } from './schemas/baggage-policy.schema';
import { CancellationPolicy } from './schemas/cancellation-policy.schema';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

import {
  CreateAirlineDto,
  UpdateAirlineDto,
} from './dto/airlines.dto';

import {
  UpdateBaggagePolicyDto,
} from './dto/baggage-policy.dto';

import {
  UpdateCancellationPolicyDto,
} from './dto/cancellation-policy.dto';

@Injectable()
export class AirlinesService {
  constructor(
    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    @InjectModel(BaggagePolicy.name)
    private readonly baggagePolicyModel: Model<BaggagePolicy>,

    @InjectModel(CancellationPolicy.name)
    private readonly cancellationPolicyModel: Model<CancellationPolicy>,
  ) {}

  // Check that the user can manage this airline
  private async checkAirlinePermission(
    userId: string,
    airlineId: string,
  ): Promise<void> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Invalid user');
    }

    const user = await this.userModel.findById(userId).exec();

    if (
      !user ||
      !user.isActive ||
      user.isSuspended ||
      user.deactivatedAt
    ) {
      throw new UnauthorizedException('Account is unavailable');
    }

    // Administrators can manage airlines
    if (user.role === UserRole.ADMIN) {
      return;
    }

    // Moderators can manage only their assigned airline
    if (
      user.role !== UserRole.MODERATOR ||
      !user.airlineId ||
      user.airlineId !== airlineId
    ) {
      throw new ForbiddenException(
        'You are not authorized to manage this airline',
      );
    }
  }

  // FLT-01: Create an airline
  async create(
    createAirlineDto: CreateAirlineDto,
    userId: string,
  ) {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new UnauthorizedException('Invalid user');
    }

    const user = await this.userModel.findById(userId).exec();

    if (
      !user ||
      !user.isActive ||
      user.isSuspended ||
      user.deactivatedAt
    ) {
      throw new UnauthorizedException('Account is unavailable');
    }

    if (user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only administrators can create airlines',
      );
    }

    const code = createAirlineDto.code.trim().toUpperCase();

    const existingAirline = await this.airlineModel.findOne({
      code,
    });

    if (existingAirline) {
      throw new ConflictException('Airline code already exists');
    }

    try {
      return await this.airlineModel.create({
        ...createAirlineDto,
        code,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException('Airline code already exists');
      }

      throw error;
    }
  }

  // FLT-01: Get airline information
  async findOne(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid airline ID');
    }

    const airline = await this.airlineModel.findById(id).exec();

    if (!airline) {
      throw new NotFoundException('Airline not found');
    }

    return airline;
  }

  // FLT-01: Update an airline
  async update(
    id: string,
    updateAirlineDto: UpdateAirlineDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException('Invalid airline ID');
    }

    await this.checkAirlinePermission(userId, id);

    await this.findOne(id);

    const updateData = { ...updateAirlineDto };

    if (updateData.code) {
      updateData.code = updateData.code.trim().toUpperCase();

      const existingAirline = await this.airlineModel.findOne({
        code: updateData.code,
        _id: { $ne: new Types.ObjectId(id) },
      });

      if (existingAirline) {
        throw new ConflictException('Airline code already exists');
      }
    }

    try {
      const updatedAirline = await this.airlineModel
        .findByIdAndUpdate(id, updateData, {
          new: true,
          runValidators: true,
        })
        .exec();

      if (!updatedAirline) {
        throw new NotFoundException('Airline not found');
      }

      return updatedAirline;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException('Airline code already exists');
      }

      throw error;
    }
  }

  // FLT-08: Get an airline's baggage policy
  async getBaggagePolicy(airlineId: string) {
    await this.findOne(airlineId);

    const policy = await this.baggagePolicyModel
      .findOne({
        airlineId: new Types.ObjectId(airlineId),
      })
      .exec();

    if (!policy) {
      throw new NotFoundException(
        'Baggage policy not found for this airline',
      );
    }

    return policy;
  }


  // FLT-08: Create or update a baggage policy
  async updateBaggagePolicy(
    airlineId: string,
    dto: UpdateBaggagePolicyDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(airlineId)) {
      throw new BadRequestException('Invalid airline ID');
    }

    await this.checkAirlinePermission(userId, airlineId);

    const airline = await this.findOne(airlineId);

    if (!airline.isActive) {
      throw new ConflictException(
        'Cannot manage policies for an inactive airline',
      );
    }

    const airlineObjectId = new Types.ObjectId(airlineId);



const policyData = {
  carryOnAllowanceKg: dto.carryOnAllowanceKg,
  checkedBaggageAllowanceKg:
    dto.checkedBaggageAllowanceKg,
  pricePerExtraBag: dto.pricePerExtraBag,
  maxExtraBagsPerPassenger:
    dto.maxExtraBagsPerPassenger,
  currency: dto.currency.trim().toUpperCase(),
};



    try {
      const policy = await this.baggagePolicyModel
        .findOneAndUpdate(
          { airlineId: airlineObjectId },
          {
            $set: policyData,
            $setOnInsert: {
              airlineId: airlineObjectId,
            },
          },
          {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .exec();

      return policy;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException(
          'Baggage policy already exists',
        );
      }

      throw error;
    }
  }


  // FLT-09: Get an airline's cancellation policy
  async getCancellationPolicy(airlineId: string) {
    await this.findOne(airlineId);

    const policy = await this.cancellationPolicyModel
      .findOne({
        airlineId: new Types.ObjectId(airlineId),
      })
      .exec();

    if (!policy) {
      throw new NotFoundException(
        'Cancellation policy not found for this airline',
      );
    }

    return policy;
  }

  // FLT-09: Create or update a cancellation policy
  async updateCancellationPolicy(
    airlineId: string,
    dto: UpdateCancellationPolicyDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(airlineId)) {
      throw new BadRequestException('Invalid airline ID');
    }

    await this.checkAirlinePermission(userId, airlineId);

    const airline = await this.findOne(airlineId);

    if (!airline.isActive) {
      throw new ConflictException(
        'Cannot manage policies for an inactive airline',
      );
    }

    const airlineObjectId = new Types.ObjectId(airlineId);


const policyData = {
  tiers: dto.tiers
    .map((tier) => ({
      daysBeforeDeparture: tier.daysBeforeDeparture,
      refundPercentage: tier.refundPercentage,
    }))
    .sort(
      (a, b) =>
        a.daysBeforeDeparture - b.daysBeforeDeparture,
    ),
  ...(dto.description !== undefined
    ? { description: dto.description }
    : {}),
};


    try {
      const policy = await this.cancellationPolicyModel
        .findOneAndUpdate(
          { airlineId: airlineObjectId },
          {
            $set: policyData,
            $setOnInsert: {
              airlineId: airlineObjectId,
            },
          },
          {
            new: true,
            upsert: true,
            runValidators: true,
            setDefaultsOnInsert: true,
          },
        )
        .exec();

      return policy;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 11000
      ) {
        throw new ConflictException(
          'Cancellation policy already exists',
        );
      }

      throw error;
    }
  }
}
