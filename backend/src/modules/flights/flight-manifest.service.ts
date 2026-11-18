import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { BOOKING_STATUS } from '../../common/booking/booking-status';
import { toCsv } from '../../common/csv/csv';
import { paged } from '../../common/pagination/pagination';
import { FlightBooking, FlightBookingPassenger, onFlight } from '../flight-bookings/schemas/flight-booking.schema';
import { passengerType } from '../flight-bookings/passenger-type';
import { CabinInventory } from './schemas/cabin-inventory.schema';
import { Flight } from './schemas/flight.schema';
import { FlightsService } from './flights.service';
import { FlightBookingsQueryDto } from './dto/flight-manifest.dto';

export const CSV_HEADER = ['booking_reference', 'full_name', 'type', 'cabin', 'passport_or_id', 'nationality', 'status'];

type Row = FlightBooking & { _id: Types.ObjectId; createdAt: Date };

/** Which flight of the booking this flight is, and the cabin booked on it (FLT-12: round trips list on both). */
function segmentOf(booking: Row, flightId: Types.ObjectId) {
  const isReturn = !!booking.returnSegment && String(booking.returnSegment.flightId) === String(flightId);
  return {
    direction: isReturn ? ('return' as const) : ('outbound' as const),
    cabinClass: isReturn ? booking.returnSegment!.cabinClass : booking.cabinClass,
  };
}

/** Stored at booking time (FLT-19); older bookings: from the date of birth on the outbound departure day. */
const typeOf = (p: FlightBookingPassenger, booking: Row) => p.type ?? passengerType(new Date(p.dateOfBirth), booking.departureTime);
const documentOf = (p: FlightBookingPassenger) => p.passportNumber ?? p.nationalId ?? '';

/**
 * FLT-29: the airline's view of one flight. Only the airline's own moderator or an admin
 * (FlightsService.checkPermission), everyone else 403.
 */
@Injectable()
export class FlightManifestService {
  constructor(
    @InjectModel(Flight.name) private readonly flights: Model<Flight>,
    @InjectModel(CabinInventory.name) private readonly cabins: Model<CabinInventory>,
    @InjectModel(FlightBooking.name) private readonly bookings: Model<FlightBooking>,
    private readonly flightsService: FlightsService,
  ) {}

  /** One row per booking, newest first, 10 per page; plus the seats left in each cabin. */
  async listBookings(userId: string, flightId: string, query: FlightBookingsQueryDto) {
    const flight = await this.ownedFlight(userId, flightId);
    const filter: Record<string, unknown> = { ...onFlight(flight._id), ...(query.status ? { status: query.status } : {}) };
    const [rows, total, cabins] = await Promise.all([
      this.bookings.find(filter as never).sort({ createdAt: -1, _id: -1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean<Row[]>().exec(),
      this.bookings.countDocuments(filter as never).exec(),
      this.cabins.find({ flightId: flight._id }).sort({ cabinClass: 1 }).lean().exec(),
    ]);
    const items = rows.map((booking) => {
      const counts = { adults: 0, children: 0, infants: 0 };
      for (const p of booking.passengers) {
        const type = typeOf(p, booking);
        if (type === 'adult') counts.adults += 1;
        else if (type === 'child') counts.children += 1;
        else counts.infants += 1;
      }
      const segment = segmentOf(booking, flight._id);
      return {
        bookingId: String(booking._id),
        reference: booking.reference ?? null,
        status: booking.status,
        tripType: booking.tripType ?? 'one-way',
        direction: segment.direction,
        cabinClass: segment.cabinClass,
        passengers: booking.passengers.map((p) => p.fullName),
        // FLT-19: travel documents and the extra bags bought on THIS flight.
        passengerDetails: booking.passengers.map((p) => ({
          fullName: p.fullName,
          type: typeOf(p, booking),
          passportOrId: documentOf(p) || null,
          nationality: p.nationality ?? null,
          extraBags: p.extraBags?.[segment.direction] ?? 0,
        })),
        passengerCounts: counts,
        bookedAt: booking.createdAt,
      };
    });
    return {
      flight: { id: String(flight._id), flightNumber: flight.flightNumber, status: flight.status, departureTime: flight.departureTime, arrivalTime: flight.arrivalTime },
      cabins: cabins.map((c) => ({ cabinClass: c.cabinClass, totalSeats: c.totalSeats, availableSeats: c.availableSeats })),
      ...paged(items, total, query.page, query.limit),
    };
  }

  /**
   * The passenger list as CSV: one row per passenger of every Confirmed or Completed booking on this
   * flight (round trips on both of their flights), with that flight's cabin. passport_or_id is the
   * passport number or else the national ID; both columns are empty for bookings made before they existed.
   */
  async exportPassengers(userId: string, flightId: string): Promise<{ filename: string; csv: string }> {
    const flight = await this.ownedFlight(userId, flightId);
    const bookings = await this.bookings
      .find({ ...onFlight(flight._id), status: { $in: [BOOKING_STATUS.CONFIRMED, BOOKING_STATUS.COMPLETED] } } as never)
      .sort({ createdAt: 1, _id: 1 })
      .lean<Row[]>()
      .exec();
    const rows: unknown[][] = [CSV_HEADER];
    for (const booking of bookings) {
      const { cabinClass } = segmentOf(booking, flight._id);
      for (const p of booking.passengers) {
        rows.push([booking.reference ?? String(booking._id), p.fullName, typeOf(p, booking), cabinClass, documentOf(p), p.nationality ?? '', booking.status]);
      }
    }
    const safeNumber = flight.flightNumber.replace(/[^A-Za-z0-9-]/g, '');
    return { filename: `passengers-${safeNumber}-${flight.departureTime.toISOString().slice(0, 10)}.csv`, csv: toCsv(rows) };
  }

  private async ownedFlight(userId: string, flightId: string) {
    if (!Types.ObjectId.isValid(flightId)) throw new BadRequestException('Invalid flight ID');
    const flight = await this.flights.findById(flightId).lean().exec();
    if (!flight) throw new NotFoundException('Flight not found');
    await this.flightsService.checkPermission(userId, String(flight.airlineId));
    return flight;
  }
}
