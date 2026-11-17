
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
import { ReferenceValidationService } from '../reference-data/reference-validation.service';
import { isValidIanaTimeZone, parseFlightInstant } from './timezone.util';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/enums/notification-type.enum';
import { FlightBooking } from '../flight-bookings/schemas/flight-booking.schema';
import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';

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

    private readonly references: ReferenceValidationService,

    private readonly payments: PaymentsService,

    private readonly notifications: NotificationsService,

    @InjectModel(FlightBooking.name)
    private readonly flightBookingModel: Model<FlightBooking>,
  ) {}

  // Check airline management permission
  /** Admin, or the moderator of this airline; anyone else is 403. */
  async checkPermission(
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

    // FLT-02: flights may only use airports from the imported reference list.
    await this.references.assertAirportCodes(
      [dto.departureAirport, dto.arrivalAirport],
      'departureAirport/arrivalAirport',
    );
    const [departureAirport, arrivalAirport] = await Promise.all([
      this.airportModel.findOne({ iataCode: dto.departureAirport.trim().toUpperCase() }).select('timeZone').lean().exec(),
      this.airportModel.findOne({ iataCode: dto.arrivalAirport.trim().toUpperCase() }).select('timeZone').lean().exec(),
    ]);
    if (!departureAirport || !arrivalAirport) throw new NotFoundException('Flight airport was not found');
    const departureTime = parseFlightInstant(dto.departureTime, departureAirport.timeZone);
    const arrivalTime = parseFlightInstant(dto.arrivalTime, arrivalAirport.timeZone);

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

    await this.references.assertAirportCodes(
      [departureAirport, arrivalAirport],
      'departureAirport/arrivalAirport',
    );
    const [departureAirportRecord, arrivalAirportRecord] = await Promise.all([
      this.airportModel.findOne({ iataCode: departureAirport }).select('timeZone').lean().exec(),
      this.airportModel.findOne({ iataCode: arrivalAirport }).select('timeZone').lean().exec(),
    ]);
    if (!departureAirportRecord || !arrivalAirportRecord) throw new NotFoundException('Flight airport was not found');
    const departureTime = dto.departureTime
      ? parseFlightInstant(dto.departureTime, departureAirportRecord.timeZone)
      : flight.departureTime;
    const arrivalTime = dto.arrivalTime
      ? parseFlightInstant(dto.arrivalTime, arrivalAirportRecord.timeZone)
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

    // GEN-01: a new departure or arrival time is announced to every Confirmed booking on the flight.
    if (
      flight.departureTime.getTime() !== departureTime.getTime() ||
      flight.arrivalTime.getTime() !== arrivalTime.getTime()
    ) {
      const affected = await this.flightBookingModel
        .find({ flightId: updatedFlight._id, status: FlightBookingStatus.CONFIRMED })
        .select({ _id: 1, userId: 1 })
        .lean()
        .exec();
      for (const booking of affected) {
        await this.notifications.notify(String(booking.userId), NotificationType.FLIGHT_SCHEDULE_CHANGED, {
          bookingType: 'flight',
          flightId: String(updatedFlight._id),
          bookingId: String(booking._id),
          departureTime: departureTime.toISOString(),
          arrivalTime: arrivalTime.toISOString(),
        });
      }
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

    // FLT-06: the flight, its holds and its Confirmed bookings change together or not at all.
    const result = await this.payments.cancelFlight(flight._id, async (session) => {
      const updated = await this.flightModel
        .findOneAndUpdate(
          { _id: flight._id, status: FlightStatus.SCHEDULED, departureTime: { $gt: new Date() } },
          { $set: { status: FlightStatus.CANCELLED } },
          { session, new: true },
        )
        .exec();
      return !!updated;
    });

    const cancelled = await this.flightModel.findById(flight._id).exec();
    return {
      flight: await this.toLocalFlightResponse(cancelled!),
      cancelledBookings: result.cancelledBookings.length,
      expiredHolds: result.expiredHolds.length,
      refunds: result.refundIds.length,
    };
  }

  async toLocalFlightResponse(flight: HydratedDocument<Flight>) {
  const airportCodes = [
    flight.departureAirport,
    flight.arrivalAirport,
  ];

  const airports = await this.airportModel
    .find({ iataCode: { $in: airportCodes } })
    .select({ iataCode: 1, timeZone: 1 })
    .lean()
    .exec();

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

  const formatLocalDateTime = (date: Date, timeZone: string): string => {
    if (!isValidIanaTimeZone(timeZone)) throw new NotFoundException('Airport has an invalid IANA time zone');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);

    const value = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';

    return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}:${value('second')}`;
  };

  return {
    ...flight.toObject(),
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
}
