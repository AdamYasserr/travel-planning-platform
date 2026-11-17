import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { UserRole } from '../../../common/enums/user-role.enum';
import { Airline } from '../../airlines/schemas/airline.schema';
import { Airport } from '../../airports/schemas/airport.schema';
import { Flight } from '../../flights/schemas/flight.schema';
import { FlightBookingStatus } from '../enums/flight-booking-status.enum';
import { FlightBooking } from '../schemas/flight-booking.schema';
import { ETicketData, renderETicketPdf } from './e-ticket.document';

/** FLT-23: the e-ticket of a paid flight booking. */
@Injectable()
export class ETicketService {
  constructor(
    @InjectModel(FlightBooking.name) private readonly bookings: Model<FlightBooking>,
    @InjectModel(Flight.name) private readonly flights: Model<Flight>,
    @InjectModel(Airline.name) private readonly airlines: Model<Airline>,
    @InjectModel(Airport.name) private readonly airports: Model<Airport>,
  ) {}

  /**
   * Owner or admin only (anyone else, and any id that is not a flight booking, is 404).
   * Only a Confirmed or Completed booking has a ticket (409 otherwise).
   */
  async render(viewer: { userId: string; role?: string }, bookingId: string): Promise<{ filename: string; pdf: Buffer }> {
    if (!Types.ObjectId.isValid(bookingId)) throw new BadRequestException('Invalid booking ID');
    const booking = await this.bookings.findById(bookingId).lean().exec();
    if (!booking || (viewer.role !== UserRole.ADMIN && String(booking.userId) !== viewer.userId)) {
      throw new NotFoundException('Flight booking not found');
    }
    if (booking.status !== FlightBookingStatus.CONFIRMED && booking.status !== FlightBookingStatus.COMPLETED) {
      throw new ConflictException(`An e-ticket is only available for a Confirmed or Completed booking (this one is ${booking.status})`);
    }
    const flight = await this.flights.findById(booking.flightId).lean().exec();
    if (!flight) throw new NotFoundException('The flight of this booking no longer exists');
    const [airline, airports] = await Promise.all([
      this.airlines.findById(flight.airlineId).lean().exec(),
      this.airports.find({ iataCode: { $in: [flight.departureAirport, flight.arrivalAirport] } }).lean().exec(),
    ]);
    const airport = (code: string) => {
      const found = airports.find((a) => a.iataCode === code);
      return { code, name: found?.name ?? code, timeZone: found?.timeZone ?? 'UTC' };
    };
    const reference = booking.reference ?? String(booking._id);
    const data: ETicketData = {
      reference,
      status: booking.status,
      passengers: booking.passengers.map((p) => p.fullName),
      flightNumber: flight.flightNumber,
      airline: { name: airline?.name ?? 'Unknown airline', code: airline?.code ?? '' },
      departure: { ...airport(flight.departureAirport), time: flight.departureTime },
      arrival: { ...airport(flight.arrivalAirport), time: flight.arrivalTime },
      cabinClass: booking.cabinClass,
      baggage: booking.baggagePolicy
        ? {
            freeBagsCount: booking.baggagePolicy.freeBagsCount,
            maxWeightPerBagKg: booking.baggagePolicy.maxWeightPerBagKg,
            carryOnAllowanceKg: booking.baggagePolicy.carryOnAllowanceKg,
            checkedBaggageAllowanceKg: booking.baggagePolicy.checkedBaggageAllowanceKg,
          }
        : null,
      totalPaid: booking.totalPrice,
      currency: booking.currency,
    };
    return { filename: `e-ticket-${reference}.pdf`, pdf: await renderETicketPdf(data) };
  }
}
