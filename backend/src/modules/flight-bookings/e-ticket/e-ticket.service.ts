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
    const data = await this.ticketData(viewer, bookingId);
    return { filename: `e-ticket-${data.reference}.pdf`, pdf: await renderETicketPdf(data) };
  }

  /** What the ticket prints (same access rules as render). */
  async ticketData(viewer: { userId: string; role?: string }, bookingId: string): Promise<ETicketData> {
    if (!Types.ObjectId.isValid(bookingId)) throw new BadRequestException('Invalid booking ID');
    const booking = await this.bookings.findById(bookingId).lean().exec();
    if (!booking || (viewer.role !== UserRole.ADMIN && String(booking.userId) !== viewer.userId)) {
      throw new NotFoundException('Flight booking not found');
    }
    if (booking.status !== FlightBookingStatus.CONFIRMED && booking.status !== FlightBookingStatus.COMPLETED) {
      throw new ConflictException(`An e-ticket is only available for a Confirmed or Completed booking (this one is ${booking.status})`);
    }
    const flight = await this.flights.findById(booking.flightId).lean().exec();
    const back = booking.returnSegment ? await this.flights.findById(booking.returnSegment.flightId).lean().exec() : null;
    if (!flight || (booking.returnSegment && !back)) throw new NotFoundException('The flight of this booking no longer exists');
    const [airlines, airports] = await Promise.all([
      this.airlines.find({ _id: { $in: [flight.airlineId, ...(back ? [back.airlineId] : [])] } }).lean().exec(),
      this.airports
        .find({ iataCode: { $in: [flight.departureAirport, flight.arrivalAirport, ...(back ? [back.departureAirport, back.arrivalAirport] : [])] } })
        .lean()
        .exec(),
    ]);
    const airlineOf = (id: unknown) => {
      const found = airlines.find((a) => String(a._id) === String(id));
      return { name: found?.name ?? 'Unknown airline', code: found?.code ?? '' };
    };
    const baggageOf = (b: FlightBooking['baggagePolicy']) =>
      b
        ? {
            freeBagsCount: b.freeBagsCount,
            maxWeightPerBagKg: b.maxWeightPerBagKg,
            carryOnAllowanceKg: b.carryOnAllowanceKg,
            checkedBaggageAllowanceKg: b.checkedBaggageAllowanceKg,
          }
        : null;
    const airport = (code: string) => {
      const found = airports.find((a) => a.iataCode === code);
      return { code, name: found?.name ?? code, timeZone: found?.timeZone ?? 'UTC' };
    };
    const reference = booking.reference ?? String(booking._id);
    const data: ETicketData = {
      reference,
      status: booking.status,
      // Children and infants are marked; adults are printed by name only.
      passengers: booking.passengers.map((p) => (p.type && p.type !== 'adult' ? `${p.fullName} (${p.type})` : p.fullName)),
      flightNumber: flight.flightNumber,
      airline: airlineOf(flight.airlineId),
      departure: { ...airport(flight.departureAirport), time: flight.departureTime },
      arrival: { ...airport(flight.arrivalAirport), time: flight.arrivalTime },
      cabinClass: booking.cabinClass,
      baggage: baggageOf(booking.baggagePolicy),
      totalPaid: booking.totalPrice,
      currency: booking.currency,
      // FLT-12: a round trip prints its return flight too.
      return:
        back && booking.returnSegment
          ? {
              flightNumber: back.flightNumber,
              airline: airlineOf(back.airlineId),
              departure: { ...airport(back.departureAirport), time: back.departureTime },
              arrival: { ...airport(back.arrivalAirport), time: back.arrivalTime },
              cabinClass: booking.returnSegment.cabinClass,
              baggage: baggageOf(booking.returnSegment.baggagePolicy),
            }
          : null,
    };
    return data;
  }
}
