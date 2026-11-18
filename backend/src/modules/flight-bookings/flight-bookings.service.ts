import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';
import type { ClientSession, Connection } from 'mongoose';

import { CabinInventory, CabinClass } from '../flights/schemas/cabin-inventory.schema';
import { Flight, FlightStatus } from '../flights/schemas/flight.schema';
import { Airline } from '../airlines/schemas/airline.schema';
import { BaggagePolicy } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy } from '../airlines/schemas/cancellation-policy.schema';
import { CreateFlightBookingDto } from './dto/flight-bookings.dto';
import { FlightBookingStatus } from './enums/flight-booking-status.enum';
import { FlightBooking } from './schemas/flight-booking.schema';
import { bookingGroupFilter, type BookingGroup } from '../../common/booking/booking-groups';
import { runBookingTransaction } from '../../common/booking/booking-transaction';
import { fromMinor, toMinor } from '../../common/currency/money';
import { fieldErrors, type FieldError } from '../../common/pipes/validation.pipe';
import { PaymentsService } from '../payments/payments.service';
import { PaymentBookingType } from '../payments/enums/payment-status.enum';
import { BOOKING_HOLD_DURATION_MS } from '../../common/booking/booking-hold';
import { ReferenceValidationService } from '../reference-data/reference-validation.service';
import { PlatformCurrencyService } from '../../common/currency/platform-currency.service';
import {
  classifyPassengers,
  countPassengers,
  extraBagRules,
  infantFareMinor,
  passengerRuleErrors,
  priceSegment,
  roundTripProblems,
  seatsFor,
  type Direction,
  type SegmentPrice,
} from './booking-rules';

/** One flight of the request, before anything is checked. `field` is where its errors are reported. */
interface SegmentRequest {
  direction: Direction;
  flightId: string;
  cabinClass?: CabinClass;
  cabinId?: string;
  field: { flight: string; cabin: string };
}

/** One flight of the booking after loading: the flight, its cabin and its airline's policies. */
interface LoadedSegment extends SegmentRequest {
  flight: Flight & { _id: Types.ObjectId };
  cabin: CabinInventory & { _id: Types.ObjectId };
  baggagePolicy: BaggagePolicy | null;
}

/** A 409 that names the field it is about, in the same `errors` shape as a 400. */
function fieldConflict(field: string, message: string) {
  return new ConflictException({ statusCode: 409, error: 'Conflict', message, errors: [{ field, messages: [message] }] });
}

@Injectable()
export class FlightBookingsService {
  constructor(
    @InjectModel(FlightBooking.name)
    private readonly bookingModel: Model<FlightBooking>,
    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,
    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventory>,
    @InjectModel(CancellationPolicy.name)
    private readonly cancellationPolicyModel: Model<CancellationPolicy>,
    @InjectModel(BaggagePolicy.name)
    private readonly baggagePolicyModel: Model<BaggagePolicy>,
    private readonly paymentsService: PaymentsService,
    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,
    private readonly references: ReferenceValidationService,
    private readonly platformCurrency: PlatformCurrencyService,
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  /**
   * Creates the booking, which IS the hold: one transaction takes the seats (adults + children) on EVERY
   * flight of the trip (one-way, or outbound + return) and creates one Pending Payment booking for 10
   * minutes. Not enough seats on any flight: 409, nothing held. The price is computed here only: per
   * flight, adults and children pay that cabin's fare, infants 10% of it, plus the extra bags.
   */
  async create(userId: string, dto: CreateFlightBookingDto) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }
    const requests = this.segmentRequests(dto);
    const now = new Date();
    const segments: LoadedSegment[] = [];
    for (const request of requests) segments.push(await this.loadSegment(request, now));
    const outbound = segments[0];
    const last = segments[segments.length - 1];

    // FLT-12: the return flies the reverse route (400) and departs after the outbound lands (409).
    const trip = segments.length === 2 ? roundTripProblems(outbound.flight, last.flight) : { errors: [], conflict: null };
    if (trip.errors.length) throw fieldErrors(trip.errors);
    if (trip.conflict) throw fieldConflict('return.flightId', trip.conflict);

    const errors: FieldError[] = passengerRuleErrors(dto.passengers, {
      outboundDeparture: outbound.flight.departureTime,
      lastArrival: last.flight.arrivalTime,
      now,
    });
    const unknown = new Set(await this.references.unknownCountryCodes(dto.passengers.map((p) => p.nationality)));
    dto.passengers.forEach((p, i) => {
      if (unknown.has(p.nationality.trim().toUpperCase())) {
        errors.push({ field: `passengers.${i}.nationality`, messages: [`Unknown country code ${p.nationality}. Use a code from GET /countries`] });
      }
    });
    // FLT-08: extra bags per flight; a one-way booking has no return bags.
    if (segments.length === 1) {
      dto.passengers.forEach((p, i) => {
        if (p.extraBags?.return !== undefined) {
          errors.push({ field: `passengers.${i}.extraBags.return`, messages: ['Return bags are only allowed on a round trip'] });
        }
      });
    }
    const bags = segments.map((segment) =>
      extraBagRules(dto.passengers, segment.direction, segment.baggagePolicy, this.platformCurrency.code),
    );
    for (const rule of bags) errors.push(...rule.errors);
    if (errors.length) throw fieldErrors(errors);
    const conflict = bags.find((rule) => rule.conflict)?.conflict;
    if (conflict) throw fieldConflict(conflict.field, conflict.message);

    const types = classifyPassengers(dto.passengers, outbound.flight.departureTime);
    const counts = countPassengers(types);
    const seats = seatsFor(counts);

    const cancellationPolicy = await this.cancellationPolicyModel
      .findOne({ airlineId: outbound.flight.airlineId })
      .lean()
      .exec();

    for (const segment of segments) {
      await this.paymentsService.expireFlightHoldsForInventory(segment.cabin._id);
    }

    return runBookingTransaction(this.connection, async (session) => {
      const held: { segment: LoadedSegment; cabin: CabinInventory & { _id: Types.ObjectId }; price: SegmentPrice }[] = [];
      for (const [index, segment] of segments.entries()) {
        const cabin = await this.holdSeats(segment, seats, session);
        const fareMinor = toMinor(cabin.price, cabin.currency);
        const extraBags = bags[index].total;
        const bagFeeMinor = extraBags > 0 ? toMinor(segment.baggagePolicy!.pricePerExtraBag, cabin.currency) : 0;
        held.push({ segment, cabin, price: priceSegment({ fareMinor, seats, infants: counts.infants, extraBags, bagFeeMinor }) });
      }
      const currency = held[0].cabin.currency;
      const totalMinor = held.reduce((sum, h) => sum + h.price.subtotalMinor, 0);
      const outboundCabin = held[0].cabin;
      const baggagePolicy = outbound.baggagePolicy;
      const back = held[1];

      const bookingData = {
        userId: new Types.ObjectId(userId),
        flightId: outbound.flight._id,
        departureTime: outbound.flight.departureTime,
        arrivalTime: outbound.flight.arrivalTime,
        tripType: (back ? 'round-trip' : 'one-way') as 'round-trip' | 'one-way',
        lastDepartureTime: last.flight.departureTime,
        returnSegment: back
          ? {
              flightId: back.segment.flight._id,
              cabinInventoryId: back.cabin._id,
              cabinClass: back.cabin.cabinClass,
              departureTime: back.segment.flight.departureTime,
              arrivalTime: back.segment.flight.arrivalTime,
              pricePerSeat: back.cabin.price,
              baggagePolicy: this.baggageSnapshot(back.segment.baggagePolicy, back.cabin),
            }
          : undefined,
        cabinInventoryId: outboundCabin._id,
        cabinClass: outboundCabin.cabinClass,
        passengers: dto.passengers.map((passenger, i) => ({
          fullName: passenger.fullName.trim(),
          dateOfBirth: new Date(`${passenger.dateOfBirth}T00:00:00.000Z`),
          type: types[i],
          ...(passenger.passportNumber !== undefined
            ? {
                passportNumber: passenger.passportNumber.trim().toUpperCase(),
                passportExpiry: new Date(`${passenger.passportExpiry}T00:00:00.000Z`),
              }
            : {}),
          ...(passenger.nationalId !== undefined ? { nationalId: passenger.nationalId.trim() } : {}),
          nationality: passenger.nationality.trim().toUpperCase(),
          extraBags: {
            outbound: passenger.extraBags?.outbound ?? 0,
            return: passenger.extraBags?.return ?? 0,
          },
        })),
        seatCount: seats,
        pricePerSeat: outboundCabin.price,
        totalPrice: fromMinor(totalMinor, currency),
        pricing: {
          segments: held.map((h) => ({
            direction: h.segment.direction,
            flightId: h.segment.flight._id,
            fare: fromMinor(h.price.fareMinor, currency),
            infantFare: fromMinor(infantFareMinor(h.price.fareMinor), currency),
            seats: h.price.seats,
            infants: h.price.infants,
            extraBags: h.price.extraBags,
            pricePerExtraBag: fromMinor(h.price.bagFeeMinor, currency),
            extraBagsFee: fromMinor(h.price.extraBagsFeeMinor, currency),
            subtotal: fromMinor(h.price.subtotalMinor, currency),
          })),
          total: fromMinor(totalMinor, currency),
        },
        currency,
        status: FlightBookingStatus.PENDING_PAYMENT,
        holdExpiresAt: new Date(now.getTime() + BOOKING_HOLD_DURATION_MS),
        reference: `FLT-${randomUUID()}`,
        policiesAcceptedAt: dto.policiesAccepted === true ? now : null,
        baggagePolicy: this.baggageSnapshot(baggagePolicy, outboundCabin),
        // The refund tier of the whole booking is decided by the OUTBOUND airline's policy and departure.
        cancellationTiers: [...(cancellationPolicy?.tiers ?? [])]
          .sort((a, b) => b.daysBeforeDeparture - a.daysBeforeDeparture)
          .map((tier) => ({
            daysBeforeDeparture: tier.daysBeforeDeparture,
            refundPercentage: tier.refundPercentage,
          })),
      };
      const [created] = await this.bookingModel.create([bookingData], { session });
      return created;
    });
  }

  async listForUser(userId: string, page = 1, limit = 10, group?: BookingGroup) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }
    await this.paymentsService.expireFlightHoldsForUser(userId);
    const filter = { userId: new Types.ObjectId(userId), ...(group ? bookingGroupFilter('flight', group) : {}) };
    const [items, totalItems] = await Promise.all([
      this.bookingModel
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean()
        .exec(),
      this.bookingModel.countDocuments(filter).exec(),
    ]);
    return {
      items,
      pagination: {
        page,
        limit,
        totalItems,
        totalPages: Math.ceil(totalItems / limit),
      },
    };
  }

  async getForUser(userId: string, bookingId: string) {
    this.validateBookingId(userId, bookingId);
    await this.paymentsService.expireFlightHold(bookingId);
    const booking = await this.bookingModel
      .findOne({ _id: bookingId, userId })
      .populate('flightId')
      .exec();
    if (!booking) {
      throw new NotFoundException('Booking not found');
    }
    return booking;
  }

  async cancel(userId: string, bookingId: string) {
    this.validateBookingId(userId, bookingId);
    return this.paymentsService.cancelBooking(
      userId,
      PaymentBookingType.FLIGHT,
      bookingId,
    );
  }

  /** The baggage terms snapshotted on a flight of the booking (PAY-02), or null without a policy. */
  private baggageSnapshot(policy: BaggagePolicy | null, cabin: CabinInventory) {
    return policy
      ? {
          carryOnAllowanceKg: policy.carryOnAllowanceKg,
          checkedBaggageAllowanceKg: policy.checkedBaggageAllowanceKg,
          pricePerExtraBag: policy.pricePerExtraBag,
          maxExtraBagsPerPassenger: policy.maxExtraBagsPerPassenger,
          currency: policy.currency,
          freeBagsCount: cabin.freeBagsCount,
          maxWeightPerBagKg: cabin.maxWeightPerBagKg,
        }
      : null;
  }

  /**
   * The flights asked for, outbound first. One-way: { flightId, cabinClass } (as before) or { outbound }.
   * Round trip: { outbound, return }. Each segment names its cabin by cabinClass OR cabinId.
   */
  private segmentRequests(dto: CreateFlightBookingDto): SegmentRequest[] {
    const errors: FieldError[] = [];
    const add = (field: string, message: string) => errors.push({ field, messages: [message] });
    const legacy = dto.flightId !== undefined || dto.cabinClass !== undefined;
    if (legacy && (dto.outbound || dto.return)) {
      add(dto.outbound ? 'outbound' : 'return', 'Send either flightId and cabinClass (one-way) or outbound/return, not both');
    } else if (legacy) {
      if (dto.flightId === undefined) add('flightId', 'flightId is required');
      if (dto.cabinClass === undefined) add('cabinClass', 'cabinClass is required');
    } else if (!dto.outbound) {
      add(dto.return ? 'outbound' : 'flightId', dto.return ? 'outbound is required for a round trip' : 'flightId (one-way) or outbound is required');
    }
    for (const direction of ['outbound', 'return'] as const) {
      const segment = dto[direction];
      if (segment && (segment.cabinClass === undefined) === (segment.cabinId === undefined)) {
        add(`${direction}.cabinClass`, 'Send exactly one of cabinClass or cabinId');
      }
    }
    if (errors.length) throw fieldErrors(errors);

    if (legacy) {
      return [{ direction: 'outbound', flightId: dto.flightId!, cabinClass: dto.cabinClass, field: { flight: 'flightId', cabin: 'cabinClass' } }];
    }
    return (['outbound', 'return'] as const)
      .filter((direction) => dto[direction])
      .map((direction) => {
        const segment = dto[direction]!;
        return {
          direction,
          flightId: segment.flightId,
          cabinClass: segment.cabinClass,
          cabinId: segment.cabinId,
          field: { flight: `${direction}.flightId`, cabin: `${direction}.${segment.cabinId !== undefined ? 'cabinId' : 'cabinClass'}` },
        };
      });
  }

  /**
   * Loads one flight with its cabin and baggage policy. Unknown flight: 404. A flight that is not
   * Scheduled, has departed, or belongs to an inactive airline: 409. No such cabin on the flight: 400.
   */
  private async loadSegment(request: SegmentRequest, now: Date): Promise<LoadedSegment> {
    const flight = await this.flightModel.findById(request.flightId).lean<Flight & { _id: Types.ObjectId }>().exec();
    if (!flight) throw new NotFoundException('Flight not found');
    if (flight.status !== FlightStatus.SCHEDULED || flight.departureTime <= now) {
      throw fieldConflict(request.field.flight, 'Flight is not available for booking');
    }
    const airline = await this.airlineModel.findById(flight.airlineId).select('isActive').lean().exec();
    if (!airline?.isActive) {
      throw fieldConflict(request.field.flight, 'Flight is not available for booking: the airline is inactive');
    }
    // A cabin id must be a cabin OF this flight; looking it up together with the flight id enforces that.
    const cabin = await this.inventoryModel
      .findOne(
        request.cabinId !== undefined
          ? { _id: new Types.ObjectId(request.cabinId), flightId: flight._id }
          : { flightId: flight._id, cabinClass: request.cabinClass },
      )
      .lean<CabinInventory & { _id: Types.ObjectId }>()
      .exec();
    if (!cabin) {
      throw fieldErrors([{
        field: request.field.cabin,
        messages: [request.cabinId !== undefined ? 'This cabin does not belong to this flight' : `This flight has no ${request.cabinClass} cabin`],
      }]);
    }
    const baggagePolicy = await this.baggagePolicyModel.findOne({ airlineId: flight.airlineId }).lean().exec();
    return { ...request, flight, cabin, baggagePolicy };
  }

  /** Takes `seats` seats on the segment's cabin inside the transaction, or throws 409. */
  private async holdSeats(segment: LoadedSegment, seats: number, session: ClientSession) {
    const cabin = await this.inventoryModel
      .findOneAndUpdate(
        { _id: segment.cabin._id, flightId: segment.flight._id, availableSeats: { $gte: seats } },
        { $inc: { availableSeats: -seats } },
        { new: true, session },
      )
      .lean<CabinInventory & { _id: Types.ObjectId }>()
      .exec();
    if (!cabin) {
      throw fieldConflict(
        segment.field.flight,
        segment.direction === 'outbound' && segment.field.flight === 'flightId'
          ? 'Not enough seats are available'
          : `Not enough seats are available on the ${segment.direction} flight`,
      );
    }
    return cabin;
  }

  private validateBookingId(userId: string, bookingId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid user or booking ID');
    }
  }

}
