
import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { HydratedDocument, Model, Types } from 'mongoose';

import {
  Flight,
  FlightStatus,
} from './schemas/flight.schema';

import { Airline } from '../airlines/schemas/airline.schema';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { Airport } from '../airports/schemas/airport.schema';
import { CabinInventory } from './schemas/cabin-inventory.schema';
import { BaggagePolicy } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy } from '../airlines/schemas/cancellation-policy.schema';
import { formatLocalDateTime } from './utils/local-time.util';

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

    @InjectModel(Airport.name)
    private readonly airportModel: Model<Airport>,

    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventory>,

    @InjectModel(BaggagePolicy.name)
    private readonly baggagePolicyModel: Model<BaggagePolicy>,

    @InjectModel(CancellationPolicy.name)
    private readonly cancellationPolicyModel: Model<CancellationPolicy>,
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

   const flight = await this.flightModel.create({
  ...dto,
  airlineId: new Types.ObjectId(dto.airlineId),
  departureAirport: dto.departureAirport.trim().toUpperCase(),
  arrivalAirport: dto.arrivalAirport.trim().toUpperCase(),
  departureTime,
  arrivalTime,
});

return this.toLocalFlightResponse(flight);
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

   return this.toLocalFlightResponse(updatedFlight);
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

  // FLT-17: Public flight details with airport-local times (GEN-06),
  // every cabin category, and the airline's baggage and cancellation policies.
  async findById(flightId: string) {
    if (!Types.ObjectId.isValid(flightId)) {
      throw new BadRequestException('Invalid flight ID');
    }

    const flight = await this.flightModel.findById(flightId).exec();

    if (!flight) {
      throw new NotFoundException('Flight not found');
    }

    const [airline, cabins, airports, baggagePolicy, cancellationPolicy] =
      await Promise.all([
        this.airlineModel
          .findById(flight.airlineId)
          .select({ name: 1, code: 1, isActive: 1 })
          .lean()
          .exec(),
        this.inventoryModel
          .find({ flightId: flight._id })
          .select({
            cabinClass: 1,
            price: 1,
            currency: 1,
            availableSeats: 1,
            freeBagsCount: 1,
            maxWeightPerBagKg: 1,
          })
          .sort({ price: 1 })
          .lean()
          .exec(),
        this.airportModel
          .find({
            iataCode: {
              $in: [flight.departureAirport, flight.arrivalAirport],
            },
          })
          .select({ iataCode: 1, name: 1, city: 1, country: 1, timeZone: 1 })
          .lean()
          .exec(),
        this.baggagePolicyModel
          .findOne({ airlineId: flight.airlineId })
          .lean()
          .exec(),
        this.cancellationPolicyModel
          .findOne({ airlineId: flight.airlineId })
          .lean()
          .exec(),
      ]);

    const localFlight = this.buildLocalTimes(flight, airports);

    const airportInfo = (code: string) => {
      const airport = airports.find((a) => a.iataCode === code);
      return {
        iataCode: code,
        name: airport?.name,
        city: airport?.city,
        country: airport?.country,
      };
    };

    return {
      ...flight.toObject(),
      ...localFlight,
      departureTime: flight.departureTime.toISOString(),
      arrivalTime: flight.arrivalTime.toISOString(),
      durationMinutes: Math.round(
        (flight.arrivalTime.getTime() - flight.departureTime.getTime()) /
          60000,
      ),
      airline: airline
        ? { id: airline._id, name: airline.name, code: airline.code }
        : null,
      departureAirportDetails: airportInfo(flight.departureAirport),
      arrivalAirportDetails: airportInfo(flight.arrivalAirport),
      cabins: cabins.map((cabin) => ({
        id: cabin._id,
        cabinClass: cabin.cabinClass,
        price: cabin.price,
        currency: cabin.currency,
        availableSeats: cabin.availableSeats,
        baggage: {
          freeBagsCount: cabin.freeBagsCount,
          maxWeightPerBagKg: cabin.maxWeightPerBagKg,
        },
      })),
      // FLT-08: Extra baggage rules (null if the airline has not set them)
      baggagePolicy: baggagePolicy
        ? {
            carryOnAllowanceKg: baggagePolicy.carryOnAllowanceKg,
            checkedBaggageAllowanceKg: baggagePolicy.checkedBaggageAllowanceKg,
            pricePerExtraBag: baggagePolicy.pricePerExtraBag,
            maxExtraBagsPerPassenger: baggagePolicy.maxExtraBagsPerPassenger,
            currency: baggagePolicy.currency,
          }
        : null,
      // FLT-09: Cancellation policy (null if the airline has not set it)
      cancellationPolicy: cancellationPolicy
        ? {
            description: cancellationPolicy.description,
            tiers: [...cancellationPolicy.tiers]
              .sort((a, b) => b.daysBeforeDeparture - a.daysBeforeDeparture)
              .map((tier) => ({
                daysBeforeDeparture: tier.daysBeforeDeparture,
                refundPercentage: tier.refundPercentage,
              })),
          }
        : null,
      isBookable:
        flight.status === FlightStatus.SCHEDULED &&
        flight.departureTime > new Date() &&
        !!airline?.isActive &&
        cabins.some((cabin) => cabin.availableSeats > 0),
    };
  }

  // GEN-06: Airport-local departure/arrival times for a flight
  private buildLocalTimes(
    flight: Pick<Flight, 'departureAirport' | 'arrivalAirport' | 'departureTime' | 'arrivalTime'>,
    airports: { iataCode: string; timeZone: string }[],
  ) {
    const departureAirport = airports.find(
      (airport) => airport.iataCode === flight.departureAirport,
    );
    const arrivalAirport = airports.find(
      (airport) => airport.iataCode === flight.arrivalAirport,
    );

    if (!departureAirport || !arrivalAirport) {
      throw new NotFoundException(
        'A flight airport or its time zone was not found',
      );
    }

    return {
      departureTimeLocal: formatLocalDateTime(
        flight.departureTime,
        departureAirport.timeZone,
      ),
      departureTimeZone: departureAirport.timeZone,
      arrivalTimeLocal: formatLocalDateTime(
        flight.arrivalTime,
        arrivalAirport.timeZone,
      ),
      arrivalTimeZone: arrivalAirport.timeZone,
    };
  }

  async toLocalFlightResponse(flight: HydratedDocument<Flight>) {
    const airports = await this.airportModel
      .find({
        iataCode: { $in: [flight.departureAirport, flight.arrivalAirport] },
      })
      .select({ iataCode: 1, timeZone: 1 })
      .lean()
      .exec();

    return {
      ...flight.toObject(),
      ...this.buildLocalTimes(flight, airports),
    };
  }
}
