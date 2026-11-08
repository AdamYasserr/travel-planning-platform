
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Flight,
  FlightStatus,
} from './schemas/flight.schema';

import { Airline } from '../airlines/schemas/airline.schema';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

import {
  CreateFlightDto,
  UpdateFlightDto,
} from './dto/flights.dto';

@Injectable()
export class FlightsService {
  constructor(
    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,

    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,
  ) {}

  // Check airline management permission
  private async checkPermission(
    userId: string,
    airlineId: string,
  ): Promise<void> {
    if (!userId || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }

    const user = await this.userModel.findById(userId).exec();

    if (
      !user ||
      !user.isActive ||
      user.isSuspended ||
      user.deactivatedAt
    ) {
      throw new ForbiddenException('Account is unavailable');
    }

    if (user.role === UserRole.ADMIN) {
      return;
    }

    if (
      user.role !== UserRole.MODERATOR ||
      !user.airlineId ||
      user.airlineId !== airlineId
    ) {
      throw new ForbiddenException(
        'You cannot manage flights for this airline',
      );
    }
  }

  // FLT-03: Create a flight
  async create(dto: CreateFlightDto, userId: string) {
    if (!Types.ObjectId.isValid(dto.airlineId)) {
      throw new BadRequestException('Invalid airline ID');
    }

    await this.checkPermission(userId, dto.airlineId);

    const airline = await this.airlineModel
      .findById(dto.airlineId)
      .exec();

    if (!airline || !airline.isActive) {
      throw new NotFoundException(
        'Airline not found or inactive',
      );
    }

    const departureTime = new Date(dto.departureTime);
    const arrivalTime = new Date(dto.arrivalTime);

    if (
      !Number.isFinite(departureTime.getTime()) ||
      !Number.isFinite(arrivalTime.getTime()) ||
      arrivalTime <= departureTime
    ) {
      throw new BadRequestException(
        'Arrival time must be after departure time',
      );
    }

    if (
      dto.departureAirport.trim().toUpperCase() ===
      dto.arrivalAirport.trim().toUpperCase()
    ) {
      throw new BadRequestException(
        'Departure and arrival airports must differ',
      );
    }

    return this.flightModel.create({
      ...dto,
      airlineId: new Types.ObjectId(dto.airlineId),
      departureAirport:
        dto.departureAirport.trim().toUpperCase(),
      arrivalAirport:
        dto.arrivalAirport.trim().toUpperCase(),
      departureTime,
      arrivalTime,
    });
  }


  // FLT-05 / FLT-30: Update scheduled flight information
  async update(
    flightId: string,
    dto: UpdateFlightDto,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(flightId)) {
      throw new BadRequestException('Invalid flight ID');
    }

    const flight = await this.flightModel
      .findById(flightId)
      .exec();

    if (!flight) {
      throw new NotFoundException('Flight not found');
    }

    await this.checkPermission(
      userId,
      flight.airlineId.toString(),
    );

    // Only future Scheduled flights may be edited
    if (
      flight.status !== FlightStatus.SCHEDULED ||
      flight.departureTime <= new Date()
    ) {
      throw new ConflictException(
        'Only scheduled flights that have not departed can be edited',
      );
    }

    // Prevent manual status changes
    if ('status' in dto) {
      throw new BadRequestException(
        'Flight status cannot be changed manually',
      );
    }

    const departureAirport = (
      dto.departureAirport ?? flight.departureAirport
    ).trim().toUpperCase();

    const arrivalAirport = (
      dto.arrivalAirport ?? flight.arrivalAirport
    ).trim().toUpperCase();

    const departureTime = dto.departureTime
      ? new Date(dto.departureTime)
      : flight.departureTime;

    const arrivalTime = dto.arrivalTime
      ? new Date(dto.arrivalTime)
      : flight.arrivalTime;

    if (departureAirport === arrivalAirport) {
      throw new BadRequestException(
        'Departure and arrival airports must differ',
      );
    }

    if (
      !Number.isFinite(departureTime.getTime()) ||
      !Number.isFinite(arrivalTime.getTime())
    ) {
      throw new BadRequestException(
        'Invalid flight date or time',
      );
    }

    if (departureTime <= new Date()) {
      throw new BadRequestException(
        'Departure time must be in the future',
      );
    }

    if (arrivalTime <= departureTime) {
      throw new BadRequestException(
        'Arrival time must be after departure time',
      );
    }

    const updatedFlight = await this.flightModel
      .findOneAndUpdate(
        {
          _id: flightId,
          status: FlightStatus.SCHEDULED,
          departureTime: { $gt: new Date() },
        },
        {
          $set: {
            ...(dto.flightNumber !== undefined
              ? { flightNumber: dto.flightNumber }
              : {}),
            departureAirport,
            arrivalAirport,
            departureTime,
            arrivalTime,
          },
        },
        {
          new: true,
          runValidators: true,
        },
      )
      .exec();

    if (!updatedFlight) {
      throw new ConflictException(
        'Flight is no longer available for editing',
      );
    }

    return updatedFlight;
  }


  // FLT-06: Cancel a flight
  async cancel(
    flightId: string,
    userId: string,
  ) {
    if (!Types.ObjectId.isValid(flightId)) {
      throw new BadRequestException('Invalid flight ID');
    }

    const flight = await this.flightModel
      .findById(flightId)
      .exec();

    if (!flight) {
      throw new NotFoundException('Flight not found');
    }

    // Verify that the user manages this airline
    await this.checkPermission(
      userId,
      flight.airlineId.toString(),
    );

    if (flight.status === FlightStatus.CANCELLED) {
      throw new ConflictException(
        'Flight is already cancelled',
      );
    }

    if (flight.status === FlightStatus.DEPARTED) {
      throw new ConflictException(
       'Departed flights cannot be cancelled',
      );
    }

    if (flight.departureTime <= new Date()) {
      throw new ConflictException(
        'Flights that have reached departure time cannot be cancelled',
      );
    }

    // Booking integration is not yet implemented.
    // Fail closed until Ahmed's booking service can verify
    // active reservations and coordinate refunds/notifications.
    throw new ConflictException(
      'Flight cancellation is unavailable until booking impact checks are integrated',
    );
  }
}
