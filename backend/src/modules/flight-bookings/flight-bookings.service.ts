import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomInt } from 'crypto';
import { ClientSession, Connection, Model, Types } from 'mongoose';

import {
  FlightBooking,
  FlightBookingPassenger,
  FlightBookingSegment,
} from './schemas/flight-booking.schema';
import {
  assertTransition,
  FlightBookingStatus,
  FlightCancelledBy,
  PassengerType,
  SegmentDirection,
} from './enums/flight-booking-status.enum';
import {
  CancelFlightBookingDto,
  CreateFlightBookingDto,
  FlightPassengerDto,
  PassengerBaggageDto,
} from './dto/flight-bookings.dto';
import {
  calculateRefund,
  calculateSegmentFare,
  passengerTypeOnDate,
  round2,
  SegmentFare,
  toCsv,
} from './utils/flight-booking-pricing';
import {
  FLIGHT_PAYMENTS_PORT,
} from './payments/flight-payments.port';
import type {
  FlightPaymentSummary,
  FlightPaymentsPort,
  FlightRefundResult,
} from './payments/flight-payments.port';
import { RefundStatus } from '../payments/enums/refund-status.enum';

import { Flight, FlightStatus } from '../flights/schemas/flight.schema';
import {
  CabinClass,
  CabinInventory,
} from '../flights/schemas/cabin-inventory.schema';
import { Airline } from '../airlines/schemas/airline.schema';
import { Airport } from '../airports/schemas/airport.schema';
import { BaggagePolicy } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy } from '../airlines/schemas/cancellation-policy.schema';
import {
  formatLocalDateTime,
  getLocalDate,
} from '../flights/utils/local-time.util';
import { User } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';

// FLT-22: Hold length
export const HOLD_DURATION_MS = 10 * 60 * 1000;

// GEN-05
export const FLIGHT_BOOKINGS_PAGE_SIZE = 10;

// FLT-23: Booking references, e.g. FB-7K3M9QX2 (no 0/O/1/I to avoid misreading)
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REFERENCE_LENGTH = 8;
const REFERENCE_ATTEMPTS = 5;

// FLT-29: Bookings an airline sees for its flight
// TODO(ASSUMPTION): The workbook says "Confirmed or Cancelled". Completed is
// included because a Confirmed booking becomes Completed after departure and
// would otherwise disappear from the airline's passenger list.
const AIRLINE_VISIBLE_STATUSES = [
  FlightBookingStatus.CONFIRMED,
  FlightBookingStatus.CANCELLED,
  FlightBookingStatus.COMPLETED,
];

// Expiry job batch size per run
const EXPIRY_BATCH_SIZE = 200;

type Id = Types.ObjectId | string;

interface FlightRecord {
  _id: Types.ObjectId;
  flightNumber: string;
  airlineId: Types.ObjectId;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: Date;
  arrivalTime: Date;
  status: FlightStatus;
}

interface CabinRecord {
  _id: Types.ObjectId;
  flightId: Types.ObjectId;
  cabinClass: CabinClass;
  totalSeats: number;
  availableSeats: number;
  price: number;
  currency: string;
  freeBagsCount: number;
  maxWeightPerBagKg: number;
}

interface BaggagePolicyRecord {
  airlineId: Types.ObjectId;
  pricePerExtraBag: number;
  maxExtraBagsPerPassenger: number;
  currency: string;
}

interface CancellationPolicyRecord {
  tiers: { daysBeforeDeparture: number; refundPercentage: number }[];
  description?: string;
}

export interface FlightBookingRecord extends FlightBooking {
  _id: Types.ObjectId;
}

interface QuoteSegment {
  direction: SegmentDirection;
  flight: FlightRecord;
  airline: { _id: Types.ObjectId; name: string; code: string };
  cabin: CabinRecord;
  fare: SegmentFare;
  pricePerExtraBag: number | null;
  baggageSubtotal: number;
}

interface QuotePassenger {
  fullName: string;
  dateOfBirth: string;
  documentNumber: string;
  passengerType: PassengerType;
  extraBags: {
    direction: SegmentDirection;
    count: number;
    weightsKg: number[];
    fee: number;
  }[];
}

interface Quote {
  segments: QuoteSegment[];
  passengers: QuotePassenger[];
  counts: { adults: number; children: number; infants: number };
  fareTotal: number;
  baggageTotal: number;
  totalPrice: number;
  currency: string;
  cancellationTiers: { daysBeforeDeparture: number; refundPercentage: number }[];
  cancellationPolicyDescription: string;
  timeZones: Map<string, string>;
}

@Injectable()
export class FlightBookingsService {
  private readonly logger = new Logger(FlightBookingsService.name);

  constructor(
    @InjectModel(FlightBooking.name)
    private readonly bookingModel: Model<FlightBooking>,

    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,

    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventory>,

    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,

    @InjectModel(Airport.name)
    private readonly airportModel: Model<Airport>,

    @InjectModel(BaggagePolicy.name)
    private readonly baggagePolicyModel: Model<BaggagePolicy>,

    @InjectModel(CancellationPolicy.name)
    private readonly cancellationPolicyModel: Model<CancellationPolicy>,

    @InjectModel(User.name)
    private readonly userModel: Model<User>,

    @InjectConnection()
    private readonly connection: Connection,

    @Inject(FLIGHT_PAYMENTS_PORT)
    private readonly payments: FlightPaymentsPort,

    private readonly configService: ConfigService,
  ) {
    // PAY-04: Platform currency, compared case-insensitively
    this.platformCurrency = (
      this.configService.get<string>('payments.currency') || 'egp'
    ).toLowerCase();
  }

  private readonly platformCurrency: string;

  // ---------------------------------------------------------------------------
  // FLT-19 / FLT-21: Booking summary (validates, reserves nothing, saves nothing)
  // ---------------------------------------------------------------------------
  async previewBooking(dto: CreateFlightBookingDto, now = new Date()) {
    const quote = await this.buildQuote(dto, now);

    return {
      tripType: quote.segments.length === 2 ? 'round-trip' : 'one-way',
      cabinClass: dto.cabinClass,
      segments: quote.segments.map((segment) =>
        this.quoteSegmentResponse(segment, quote.timeZones),
      ),
      passengers: quote.passengers.map((passenger) => ({
        fullName: passenger.fullName,
        dateOfBirth: passenger.dateOfBirth,
        passengerType: passenger.passengerType,
        extraBags: passenger.extraBags,
      })),
      passengerCounts: quote.counts,
      fareTotal: quote.fareTotal,
      baggageTotal: quote.baggageTotal,
      totalPrice: quote.totalPrice,
      currency: quote.currency,
      cancellationPolicy: {
        description: quote.cancellationPolicyDescription,
        tiers: quote.cancellationTiers,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // FLT-22: Create a Pending Payment hold (atomic seat reservation)
  // ---------------------------------------------------------------------------
  async createHold(
    dto: CreateFlightBookingDto,
    userId: string,
    now = new Date(),
  ) {
    this.assertObjectId(userId, 'user');

    const quote = await this.buildQuote(dto, now);
    const holdExpiresAt = new Date(now.getTime() + HOLD_DURATION_MS);

    const booking = await this.connection.transaction(async (session) => {
      for (const segment of quote.segments) {
        // The flight must still be bookable inside the transaction
        const stillOpen = await this.flightModel
          .findOne(
            {
              _id: segment.flight._id,
              status: FlightStatus.SCHEDULED,
              departureTime: { $gt: now },
            },
            { _id: 1 },
            { session },
          )
          .lean()
          .exec();

        if (!stillOpen) {
          throw new ConflictException(
            `Flight ${segment.flight.flightNumber} is no longer available for booking`,
          );
        }

        // Atomic check-and-decrement: two requests can never take the same seat
        const reserved = await this.inventoryModel
          .findOneAndUpdate(
            {
              _id: segment.cabin._id,
              flightId: segment.flight._id,
              availableSeats: { $gte: segment.fare.seats },
            },
            { $inc: { availableSeats: -segment.fare.seats } },
            { new: true, session },
          )
          .exec();

        if (!reserved) {
          // Throwing aborts the transaction, so a seat already reserved on the
          // other segment is rolled back too.
          throw new ConflictException(
            `Not enough ${segment.cabin.cabinClass} seats on flight ${segment.flight.flightNumber}`,
          );
        }
      }

      const [created] = await this.bookingModel.create(
        [
          {
            userId: new Types.ObjectId(userId),
            segments: quote.segments.map((segment) =>
              this.toSegmentDocument(segment),
            ),
            outboundDepartureTime: quote.segments[0].flight.departureTime,
            passengers: quote.passengers.map((passenger) => ({
              fullName: passenger.fullName,
              dateOfBirth: new Date(`${passenger.dateOfBirth}T00:00:00.000Z`),
              documentNumber: passenger.documentNumber,
              passengerType: passenger.passengerType,
              extraBags: passenger.extraBags,
            })),
            adults: quote.counts.adults,
            children: quote.counts.children,
            infants: quote.counts.infants,
            fareTotal: quote.fareTotal,
            baggageTotal: quote.baggageTotal,
            totalPrice: quote.totalPrice,
            currency: quote.currency,
            status: FlightBookingStatus.PENDING_PAYMENT,
            holdExpiresAt,
            policiesAcceptedAt: null,
            cancellationTiers: quote.cancellationTiers,
            cancellationPolicyDescription: quote.cancellationPolicyDescription,
          },
        ],
        { session },
      );

      return created;
    });

    return this.toBookingResponse(
      booking.toObject() as FlightBookingRecord,
      quote.timeZones,
      now,
    );
  }

  // ---------------------------------------------------------------------------
  // FLT-23: Confirm after verified payment. Service method only, for the
  // future payments webhook. There is deliberately no public endpoint.
  // ---------------------------------------------------------------------------
  async confirmBooking(bookingId: string, now = new Date()) {
    this.assertObjectId(bookingId, 'booking');

    const booking = await this.bookingModel
      .findById(bookingId)
      .lean<FlightBookingRecord>()
      .exec();

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // FLT-22: A hold whose time has passed is expired even if the job has
    // not run yet.
    if (this.isHoldTimeOver(booking, now)) {
      await this.expireBooking(bookingId, now);
      throw new ConflictException('The 10-minute seat hold has expired');
    }

    assertTransition(booking.status, FlightBookingStatus.CONFIRMED);

    // PAY-01: Never confirm before the payment is verified
    const verification = await this.payments.confirmPayment(bookingId);

    if (!verification.succeeded) {
      throw new ConflictException('Payment has not been verified');
    }

    let confirmed: FlightBookingRecord | null = null;

    for (let attempt = 0; attempt < REFERENCE_ATTEMPTS; attempt++) {
      try {
        confirmed = await this.bookingModel
          .findOneAndUpdate(
            {
              _id: new Types.ObjectId(bookingId),
              status: FlightBookingStatus.PENDING_PAYMENT,
              holdExpiresAt: { $gt: now },
            },
            {
              $set: {
                status: FlightBookingStatus.CONFIRMED,
                confirmedAt: now,
                reference: this.generateReference(),
                paymentId: verification.paymentId ?? null,
              },
            },
            { new: true },
          )
          .lean<FlightBookingRecord>()
          .exec();
        break;
      } catch (error) {
        if (this.isDuplicateReferenceError(error)) {
          continue; // Reference collision: try another one
        }
        throw error;
      }
    }

    if (!confirmed) {
      // The hold expired or the status changed between the checks
      await this.expireBooking(bookingId, now);
      // PAY-01: The payments webhook refunds a succeeded payment in full when
      // its booking ends up Expired.
      throw new ConflictException(
        'Booking could not be confirmed because its hold expired or changed',
      );
    }

    // TODO(GEN-01): Send an in-app "booking confirmed" notification once the
    // notifications module exists.

    return this.toBookingResponse(
      confirmed,
      await this.loadTimeZones([confirmed]),
      now,
    );
  }

  // ---------------------------------------------------------------------------
  // FLT-22: Expire one hold and give its seats back (exactly once)
  // ---------------------------------------------------------------------------
  async expireBooking(bookingId: Id, now = new Date()): Promise<boolean> {
    const expired = await this.expireBookingInTransaction(bookingId, now);

    if (expired) {
      // PAY-01: Cancel any open PaymentIntent, once, after the commit
      await this.cancelPendingPaymentsSafely(String(bookingId));
      // TODO(GEN-01): Notify the user that the hold expired.
    }

    return expired;
  }

  private async expireBookingInTransaction(
    bookingId: Id,
    now: Date,
  ): Promise<boolean> {
    return this.connection.transaction(async (session) => {
      // The status-guarded update is the "only once" guard: a second run (or a
      // concurrent job) finds nothing to update and releases nothing.
      const expired = await this.bookingModel
        .findOneAndUpdate(
          {
            _id: new Types.ObjectId(String(bookingId)),
            status: FlightBookingStatus.PENDING_PAYMENT,
            holdExpiresAt: { $lte: now },
          },
          {
            $set: { status: FlightBookingStatus.EXPIRED, expiredAt: now },
          },
          { new: true, session },
        )
        .lean<FlightBookingRecord>()
        .exec();

      if (!expired) {
        return false;
      }

      await this.releaseSeats(expired.segments, session);
      return true;
    });
  }

  // Called by the expiry job every minute
  async expireDueHolds(now = new Date()): Promise<number> {
    const due = await this.bookingModel
      .find({
        status: FlightBookingStatus.PENDING_PAYMENT,
        holdExpiresAt: { $lte: now },
      })
      .select({ _id: 1 })
      .limit(EXPIRY_BATCH_SIZE)
      .lean<{ _id: Types.ObjectId }[]>()
      .exec();

    let expiredCount = 0;

    for (const { _id } of due) {
      try {
        if (await this.expireBooking(_id, now)) {
          expiredCount++;
          // TODO(GEN-01): Notify the user that the hold expired.
        }
      } catch (error) {
        this.logger.error(
          `Could not expire flight booking ${String(_id)}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return expiredCount;
  }

  // GEN-11: Confirmed -> Completed once the outbound departure time has passed
  async completeDepartedBookings(now = new Date()): Promise<number> {
    const result = await this.bookingModel
      .updateMany(
        {
          status: FlightBookingStatus.CONFIRMED,
          outboundDepartureTime: { $lte: now },
        },
        {
          $set: { status: FlightBookingStatus.COMPLETED, completedAt: now },
        },
      )
      .exec();

    return result.modifiedCount;
  }

  // ---------------------------------------------------------------------------
  // FLT-25: The user's own bookings
  // ---------------------------------------------------------------------------
  async findMine(userId: string, now = new Date()) {
    this.assertObjectId(userId, 'user');

    const bookings = await this.bookingModel
      .find({
        userId: new Types.ObjectId(userId),
        status: { $ne: FlightBookingStatus.EXPIRED },
      })
      .sort({ outboundDepartureTime: 1, _id: 1 })
      .lean<FlightBookingRecord[]>()
      .exec();

    // Expired holds are not listed, even before the job has run
    const visible = bookings.filter(
      (booking) => !this.isHoldTimeOver(booking, now),
    );
    const timeZones = await this.loadTimeZones(visible);

    const groups = {
      upcoming: [] as ReturnType<FlightBookingsService['toListItem']>[],
      past: [] as ReturnType<FlightBookingsService['toListItem']>[],
      cancelled: [] as ReturnType<FlightBookingsService['toListItem']>[],
    };

    for (const booking of visible) {
      const item = this.toListItem(booking, timeZones);

      if (booking.status === FlightBookingStatus.CANCELLED) {
        groups.cancelled.push(item);
      } else if (
        booking.status === FlightBookingStatus.COMPLETED ||
        booking.outboundDepartureTime <= now
      ) {
        groups.past.push(item);
      } else {
        groups.upcoming.push(item);
      }
    }

    // Most recent past trips first
    groups.past.reverse();

    return groups;
  }

  // FLT-25: One booking, owner only (others get 404)
  async findMineById(userId: string, bookingId: string, now = new Date()) {
    const booking = await this.loadOwned(userId, bookingId);

    const [timeZones, payment] = await Promise.all([
      this.loadTimeZones([booking]),
      // PAY-03: Payment and refund status come from the Payment record
      this.payments.getPaymentSummary(String(booking._id)),
    ]);

    return this.toBookingResponse(booking, timeZones, now, payment);
  }

  // ---------------------------------------------------------------------------
  // PAY-01 / PAY-02 / PAY-04: Used by PaymentsService.createFlightPayment
  // ---------------------------------------------------------------------------
  async getPayableBooking(userId: string, bookingId: string, now = new Date()) {
    const booking = await this.loadOwned(userId, bookingId);

    if (this.isHoldTimeOver(booking, now)) {
      await this.expireBooking(bookingId, now);
      throw new ConflictException('The 10-minute seat hold has expired');
    }

    if (booking.status !== FlightBookingStatus.PENDING_PAYMENT) {
      throw new ConflictException('This booking is not awaiting payment');
    }

    // PAY-02: Policies must be accepted before payment
    if (!booking.policiesAcceptedAt) {
      throw new ConflictException(
        'You must accept the booking policies before payment',
      );
    }

    // PAY-04: Single platform currency (case-insensitive)
    if (booking.currency.toLowerCase() !== this.platformCurrency) {
      throw new ConflictException(
        `This booking is priced in ${booking.currency}, but payments use ${this.platformCurrency.toUpperCase()}`,
      );
    }

    return {
      id: String(booking._id),
      totalPrice: booking.totalPrice,
      currency: booking.currency,
      holdExpiresAt: booking.holdExpiresAt,
      policiesAcceptedAt: booking.policiesAcceptedAt,
    };
  }

  // Used by the payments webhook to decide between confirm and late refund
  async getBookingStatus(bookingId: string): Promise<FlightBookingStatus | null> {
    this.assertObjectId(bookingId, 'booking');

    const booking = await this.bookingModel
      .findById(bookingId)
      .select({ status: 1 })
      .lean<{ status: FlightBookingStatus }>()
      .exec();

    return booking?.status ?? null;
  }

  // ---------------------------------------------------------------------------
  // FLT-23: E-ticket (JSON), Confirmed bookings only, owner only
  // ---------------------------------------------------------------------------
  async getETicket(userId: string, bookingId: string) {
    const booking = await this.loadOwned(userId, bookingId);

    if (booking.status !== FlightBookingStatus.CONFIRMED) {
      throw new ConflictException(
        'An e-ticket is only available for Confirmed bookings',
      );
    }

    const timeZones = await this.loadTimeZones([booking]);
    const airlines = await this.airlineModel
      .find({ _id: { $in: booking.segments.map((s) => s.airlineId) } })
      .select({ name: 1, code: 1 })
      .lean<{ _id: Types.ObjectId; name: string; code: string }[]>()
      .exec();

    return {
      reference: booking.reference,
      issuedAt: booking.confirmedAt,
      status: booking.status,
      cabinClass: booking.segments[0].cabinClass,
      segments: booking.segments.map((segment) => {
        const airline = airlines.find(
          (a) => String(a._id) === String(segment.airlineId),
        );
        return {
          direction: segment.direction,
          airline: airline
            ? { name: airline.name, code: airline.code }
            : null,
          flightNumber: segment.flightNumber,
          ...this.segmentTimes(segment, timeZones),
          cabinClass: segment.cabinClass,
          freeBagsCount: segment.freeBagsCount,
          maxWeightPerBagKg: segment.maxWeightPerBagKg,
        };
      }),
      passengers: booking.passengers.map((passenger) => ({
        fullName: passenger.fullName,
        passengerType: passenger.passengerType,
        documentNumber: passenger.documentNumber,
        extraBags: passenger.extraBags.map((bags) => ({
          direction: bags.direction,
          count: bags.count,
        })),
      })),
      totalPaid: booking.totalPrice,
      currency: booking.currency,
    };
  }

  // ---------------------------------------------------------------------------
  // PAY-02: Record policy acceptance (owner, Pending Payment only)
  // ---------------------------------------------------------------------------
  async acceptPolicies(userId: string, bookingId: string, now = new Date()) {
    const booking = await this.loadOwned(userId, bookingId);

    if (this.isHoldTimeOver(booking, now)) {
      await this.expireBooking(bookingId, now);
      throw new ConflictException('The 10-minute seat hold has expired');
    }

    if (booking.status !== FlightBookingStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        'Policies can only be accepted for Pending Payment bookings',
      );
    }

    if (booking.policiesAcceptedAt) {
      return {
        bookingId: booking._id,
        policiesAcceptedAt: booking.policiesAcceptedAt,
      };
    }

    const updated = await this.bookingModel
      .findOneAndUpdate(
        {
          _id: booking._id,
          userId: booking.userId,
          status: FlightBookingStatus.PENDING_PAYMENT,
          holdExpiresAt: { $gt: now },
        },
        { $set: { policiesAcceptedAt: now } },
        { new: true },
      )
      .lean<FlightBookingRecord>()
      .exec();

    if (!updated) {
      throw new ConflictException('The booking can no longer be changed');
    }

    return {
      bookingId: updated._id,
      policiesAcceptedAt: updated.policiesAcceptedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // FLT-26: Cancel (preview first, then confirm = true)
  // ---------------------------------------------------------------------------
  async cancel(
    userId: string,
    bookingId: string,
    dto: CancelFlightBookingDto,
    now = new Date(),
  ) {
    const booking = await this.loadOwned(userId, bookingId);

    // PAY-03: Retry a failed refund of a cancelled booking. No status change.
    if (booking.status === FlightBookingStatus.CANCELLED) {
      const payment = await this.payments.getPaymentSummary(bookingId);

      if (
        payment?.refundStatus === RefundStatus.FAILED &&
        (booking.refundAmount ?? 0) > 0
      ) {
        if (dto.confirm !== true) {
          return {
            preview: true,
            retryRefund: true,
            bookingId: booking._id,
            reference: booking.reference,
            refundAmount: booking.refundAmount,
            currency: booking.currency,
            message: 'The previous refund failed. Send confirm: true to retry it',
          };
        }

        await this.requestRefundOrThrow(
          bookingId,
          booking.refundAmount as number,
          'The refund could not be created. The booking stays Cancelled; please try again.',
        );

        return this.toBookingResponse(
          booking,
          await this.loadTimeZones([booking]),
          now,
          await this.payments.getPaymentSummary(bookingId),
        );
      }
    }

    if (booking.status === FlightBookingStatus.PENDING_PAYMENT) {
      throw new ConflictException(
        'A Pending Payment hold cannot be cancelled; it expires automatically',
      );
    }

    assertTransition(booking.status, FlightBookingStatus.CANCELLED);

    if (booking.outboundDepartureTime <= now) {
      throw new ConflictException(
        'A booking cannot be cancelled after departure',
      );
    }

    const refund = calculateRefund(
      booking.totalPrice,
      booking.cancellationTiers,
      booking.outboundDepartureTime,
      now,
    );

    if (dto.confirm !== true) {
      return {
        preview: true,
        bookingId: booking._id,
        reference: booking.reference,
        totalPrice: booking.totalPrice,
        currency: booking.currency,
        ...refund,
        message: 'Send confirm: true to cancel this booking',
      };
    }

    // PAY-03: Create the refund FIRST. If Stripe fails, nothing changes and
    // the booking stays Confirmed, so the user can simply try again. Retries
    // reuse a refund Stripe already created, so money is never refunded twice.
    if (refund.refundAmount > 0) {
      await this.requestRefundOrThrow(
        bookingId,
        refund.refundAmount,
        'The refund could not be created. The booking was not changed and is still Confirmed; please try again.',
      );
    }

    const cancelled = await this.cancelConfirmedBooking(
      booking._id,
      {
        cancelledBy: FlightCancelledBy.USER,
        refundPercentage: refund.refundPercentage,
        refundAmount: refund.refundAmount,
        userId: booking.userId,
        mustDepartAfter: now,
      },
      now,
    );

    if (!cancelled) {
      // TODO(ASSUMPTION): The refund exists but the booking changed in between
      // (e.g. a concurrent cancel already cancelled it). Logged for follow-up.
      this.logger.error(
        `Refund requested but booking ${bookingId} could not be cancelled`,
      );
      throw new ConflictException('The booking can no longer be cancelled');
    }

    // TODO(GEN-01): Notify the user about the cancellation and refund.

    return this.toBookingResponse(
      cancelled,
      await this.loadTimeZones([cancelled]),
      now,
      await this.payments.getPaymentSummary(bookingId),
    );
  }

  // ---------------------------------------------------------------------------
  // FLT-06: For the airline's flight cancellation (to be called by
  // FlightsService.cancel). Confirmed bookings are cancelled with a 100%
  // refund; Pending Payment holds are expired. Seats of every segment go back.
  // ---------------------------------------------------------------------------
  async cancelBookingsForFlight(flightId: string, now = new Date()) {
    this.assertObjectId(flightId, 'flight');

    const bookings = await this.bookingModel
      .find({
        'segments.flightId': new Types.ObjectId(flightId),
        status: {
          $in: [
            FlightBookingStatus.PENDING_PAYMENT,
            FlightBookingStatus.CONFIRMED,
          ],
        },
      })
      .lean<FlightBookingRecord[]>()
      .exec();

    let cancelled = 0;
    let expired = 0;

    for (const booking of bookings) {
      if (booking.status === FlightBookingStatus.PENDING_PAYMENT) {
        // TODO(ASSUMPTION): GEN-11 does not allow Pending Payment -> Cancelled,
        // so holds on a cancelled flight are expired immediately instead.
        const done = await this.connection.transaction(async (session) => {
          const updated = await this.bookingModel
            .findOneAndUpdate(
              { _id: booking._id, status: FlightBookingStatus.PENDING_PAYMENT },
              { $set: { status: FlightBookingStatus.EXPIRED, expiredAt: now } },
              { new: true, session },
            )
            .lean<FlightBookingRecord>()
            .exec();

          if (!updated) return false;
          await this.releaseSeats(updated.segments, session);
          return true;
        });

        if (done) {
          expired++;
          await this.cancelPendingPaymentsSafely(String(booking._id));
        }
        continue;
      }

      const updated = await this.cancelConfirmedBooking(
        booking._id,
        {
          cancelledBy: FlightCancelledBy.AIRLINE,
          refundPercentage: 100,
          refundAmount: booking.totalPrice,
        },
        now,
      );

      if (updated) {
        cancelled++;
        await this.requestRefund(updated);
        // TODO(GEN-01): Notify the user that the airline cancelled the flight.
      }
    }

    return { cancelled, expired };
  }

  // ---------------------------------------------------------------------------
  // FLT-29: Bookings of one flight (airline moderator of that airline, or admin)
  // ---------------------------------------------------------------------------
  async findFlightBookings(userId: string, flightId: string, page = 1) {
    const flight = await this.loadManagedFlight(userId, flightId);

    const filter = {
      'segments.flightId': flight._id,
      status: { $in: AIRLINE_VISIBLE_STATUSES },
    };

    const [bookings, totalItems, cabins] = await Promise.all([
      this.bookingModel
        .find(filter)
        .sort({ createdAt: 1, _id: 1 })
        .skip((page - 1) * FLIGHT_BOOKINGS_PAGE_SIZE)
        .limit(FLIGHT_BOOKINGS_PAGE_SIZE)
        .lean<FlightBookingRecord[]>()
        .exec(),
      this.bookingModel.countDocuments(filter).exec(),
      this.inventoryModel
        .find({ flightId: flight._id })
        .sort({ price: 1 })
        .lean<CabinRecord[]>()
        .exec(),
    ]);

    const totalPages = Math.ceil(totalItems / FLIGHT_BOOKINGS_PAGE_SIZE);

    return {
      flight: {
        id: flight._id,
        flightNumber: flight.flightNumber,
        departureAirport: flight.departureAirport,
        arrivalAirport: flight.arrivalAirport,
        departureTime: flight.departureTime,
        status: flight.status,
      },
      seatsRemaining: cabins.map((cabin) => ({
        cabinClass: cabin.cabinClass,
        availableSeats: cabin.availableSeats,
        totalSeats: cabin.totalSeats,
      })),
      items: bookings.map((booking) => {
        const segment = this.segmentForFlight(booking, flight._id);
        return {
          bookingId: booking._id,
          reference: booking.reference,
          status: booking.status,
          direction: segment?.direction,
          cabinClass: segment?.cabinClass,
          seats: segment?.seats ?? 0,
          passengers: booking.passengers.map((passenger) => ({
            fullName: passenger.fullName,
            passengerType: passenger.passengerType,
          })),
        };
      }),
      // GEN-05: Same format as the hotels module
      pagination: {
        page,
        pageSize: FLIGHT_BOOKINGS_PAGE_SIZE,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      },
    };
  }

  // FLT-29: Passenger list CSV. No passport numbers or dates of birth.
  async exportFlightPassengers(userId: string, flightId: string) {
    const flight = await this.loadManagedFlight(userId, flightId);

    const bookings = await this.bookingModel
      .find({
        'segments.flightId': flight._id,
        status: { $in: AIRLINE_VISIBLE_STATUSES },
      })
      .sort({ createdAt: 1, _id: 1 })
      .lean<FlightBookingRecord[]>()
      .exec();

    const rows: unknown[][] = [
      [
        'Booking Reference',
        'Passenger Name',
        'Passenger Type',
        'Cabin',
        'Seats',
        'Status',
      ],
    ];

    for (const booking of bookings) {
      const segment = this.segmentForFlight(booking, flight._id);

      for (const passenger of booking.passengers) {
        rows.push([
          booking.reference ?? '',
          passenger.fullName,
          passenger.passengerType,
          segment?.cabinClass ?? '',
          // Infants take no seat
          passenger.passengerType === PassengerType.INFANT ? 0 : 1,
          booking.status,
        ]);
      }
    }

    const safeNumber = flight.flightNumber.replace(/[^A-Za-z0-9-]/g, '');
    const date = flight.departureTime.toISOString().slice(0, 10);

    return {
      filename: `passengers-${safeNumber || 'flight'}-${date}.csv`,
      csv: toCsv(rows),
    };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  // FLT-19 / FLT-21 / FLT-22: Validate everything and price the booking
  private async buildQuote(
    dto: CreateFlightBookingDto,
    now: Date,
  ): Promise<Quote> {
    const isRoundTrip = dto.returnFlightId !== undefined;

    if (isRoundTrip && dto.returnFlightId === dto.outboundFlightId) {
      throw new BadRequestException(
        'The return flight must differ from the outbound flight',
      );
    }

    if (!isRoundTrip && dto.passengers.some((p) => p.returnBaggage)) {
      throw new BadRequestException(
        'returnBaggage can only be given for a round trip (returnFlightId)',
      );
    }

    // --- Flights -------------------------------------------------------------
    const flightIds = [dto.outboundFlightId, dto.returnFlightId]
      .filter((id): id is string => id !== undefined)
      .map((id) => new Types.ObjectId(id));

    const flights = await this.flightModel
      .find({ _id: { $in: flightIds } })
      .lean<FlightRecord[]>()
      .exec();

    const outbound = flights.find(
      (f) => String(f._id) === dto.outboundFlightId,
    );
    const inbound = isRoundTrip
      ? flights.find((f) => String(f._id) === dto.returnFlightId)
      : undefined;

    if (!outbound || (isRoundTrip && !inbound)) {
      throw new NotFoundException('Flight not found');
    }

    const legs: { direction: SegmentDirection; flight: FlightRecord }[] = [
      { direction: SegmentDirection.OUTBOUND, flight: outbound },
    ];

    if (inbound) {
      legs.push({ direction: SegmentDirection.RETURN, flight: inbound });
    }

    for (const { flight } of legs) {
      // FLT-30: Only Scheduled flights that have not departed
      if (flight.status !== FlightStatus.SCHEDULED) {
        throw new ConflictException(
          `Flight ${flight.flightNumber} is not available for booking (${flight.status})`,
        );
      }

      if (flight.departureTime <= now) {
        throw new ConflictException(
          `Flight ${flight.flightNumber} has already departed`,
        );
      }
    }

    if (inbound) {
      // FLT-12(a): Reversed route
      if (
        inbound.departureAirport !== outbound.arrivalAirport ||
        inbound.arrivalAirport !== outbound.departureAirport
      ) {
        throw new BadRequestException(
          'The return flight must fly the reversed route of the outbound flight',
        );
      }

      // TODO(ASSUMPTION): FLT-12(a) says the return date is not before the
      // departure date; the safest check is that the return flight departs
      // after the outbound flight arrives.
      if (inbound.departureTime <= outbound.arrivalTime) {
        throw new BadRequestException(
          'The return flight must depart after the outbound flight arrives',
        );
      }
    }

    // --- Airlines, cabins, policies, airports (batched) -----------------------
    const airlineIds = [...new Set(legs.map((l) => String(l.flight.airlineId)))]
      .map((id) => new Types.ObjectId(id));

    const airportCodes = [
      ...new Set(
        legs.flatMap((l) => [l.flight.departureAirport, l.flight.arrivalAirport]),
      ),
    ];

    const [airlines, cabins, baggagePolicies, cancellationPolicy, airports] =
      await Promise.all([
        this.airlineModel
          .find({ _id: { $in: airlineIds } })
          .select({ name: 1, code: 1, isActive: 1 })
          .lean<
            { _id: Types.ObjectId; name: string; code: string; isActive: boolean }[]
          >()
          .exec(),
        this.inventoryModel
          .find({ flightId: { $in: flightIds }, cabinClass: dto.cabinClass })
          .lean<CabinRecord[]>()
          .exec(),
        this.baggagePolicyModel
          .find({ airlineId: { $in: airlineIds } })
          .lean<BaggagePolicyRecord[]>()
          .exec(),
        // FLT-09 / FLT-26: Refund tiers come from the OUTBOUND airline
        this.cancellationPolicyModel
          .findOne({ airlineId: outbound.airlineId })
          .lean<CancellationPolicyRecord>()
          .exec(),
        this.airportModel
          .find({ iataCode: { $in: airportCodes } })
          .select({ iataCode: 1, timeZone: 1 })
          .lean<{ iataCode: string; timeZone: string }[]>()
          .exec(),
      ]);

    const timeZones = new Map(airports.map((a) => [a.iataCode, a.timeZone]));

    for (const code of airportCodes) {
      if (!timeZones.has(code)) {
        throw new NotFoundException(
          `Airport ${code} or its time zone was not found`,
        );
      }
    }

    // --- Passengers (FLT-19, FLT-12b) ------------------------------------------
    // Age band at the outbound departure date (local date at the airport)
    const travelDate = getLocalDate(
      outbound.departureTime,
      timeZones.get(outbound.departureAirport) as string,
    );
    const today = now.toISOString().slice(0, 10);
    const seenDocuments = new Set<string>();

    const typed = dto.passengers.map((passenger) => {
      if (passenger.dateOfBirth > today) {
        throw new BadRequestException(
          `Date of birth of ${passenger.fullName} cannot be in the future`,
        );
      }

      const documentKey = passenger.documentNumber
        .replace(/[\s-]/g, '')
        .toUpperCase();

      if (seenDocuments.has(documentKey)) {
        throw new BadRequestException(
          `Passport/ID number ${passenger.documentNumber} is used more than once in this booking`,
        );
      }
      seenDocuments.add(documentKey);

      return {
        passenger,
        passengerType: passengerTypeOnDate(passenger.dateOfBirth, travelDate),
      };
    });

    const counts = {
      adults: typed.filter((p) => p.passengerType === PassengerType.ADULT).length,
      children: typed.filter((p) => p.passengerType === PassengerType.CHILD).length,
      infants: typed.filter((p) => p.passengerType === PassengerType.INFANT).length,
    };

    if (counts.adults < 1) {
      throw new BadRequestException(
        'At least one adult (12 or older at departure) is required',
      );
    }

    if (counts.infants > counts.adults) {
      throw new BadRequestException(
        'The number of infants cannot exceed the number of adults',
      );
    }

    // --- Segments: cabin, seats, fares -----------------------------------------
    const segments: QuoteSegment[] = legs.map(({ direction, flight }) => {
      const airline = airlines.find(
        (a) => String(a._id) === String(flight.airlineId),
      );

      if (!airline || !airline.isActive) {
        throw new ConflictException(
          `The airline of flight ${flight.flightNumber} is not active`,
        );
      }

      const cabin = cabins.find(
        (c) => String(c.flightId) === String(flight._id),
      );

      if (!cabin) {
        throw new ConflictException(
          `Flight ${flight.flightNumber} has no ${dto.cabinClass} cabin`,
        );
      }

      const fare = calculateSegmentFare(cabin.price, counts);

      // Early, friendly check; the real guarantee is the atomic update
      if (cabin.availableSeats < fare.seats) {
        throw new ConflictException(
          `Not enough ${cabin.cabinClass} seats on flight ${flight.flightNumber}`,
        );
      }

      const policy = baggagePolicies.find(
        (p) => String(p.airlineId) === String(flight.airlineId),
      );

      return {
        direction,
        flight,
        airline: { _id: airline._id, name: airline.name, code: airline.code },
        cabin,
        fare,
        pricePerExtraBag: policy?.pricePerExtraBag ?? null,
        baggageSubtotal: 0,
      };
    });

    // --- Extra baggage (FLT-19, FLT-08) ---------------------------------------
    const currencies = new Set(segments.map((s) => s.cabin.currency));

    const passengers: QuotePassenger[] = typed.map(({ passenger, passengerType }) => {
      const extraBags: QuotePassenger['extraBags'] = [];

      for (const segment of segments) {
        const baggage = this.baggageFor(passenger, segment.direction);
        const count = baggage?.extraBags ?? 0;
        const weights = baggage?.bagWeightsKg ?? [];

        if (count === 0) {
          if (weights.length > 0) {
            throw new BadRequestException(
              `bagWeightsKg given without extra bags for ${passenger.fullName}`,
            );
          }
          continue;
        }

        if (passengerType === PassengerType.INFANT) {
          throw new BadRequestException(
            `Infants cannot have extra bags (${passenger.fullName})`,
          );
        }

        const policy = baggagePolicies.find(
          (p) => String(p.airlineId) === String(segment.flight.airlineId),
        );

        if (!policy) {
          throw new BadRequestException(
            `Extra bags are not allowed on flight ${segment.flight.flightNumber}: the airline has no baggage policy`,
          );
        }

        if (count > policy.maxExtraBagsPerPassenger) {
          throw new BadRequestException(
            `At most ${policy.maxExtraBagsPerPassenger} extra bag(s) per passenger on flight ${segment.flight.flightNumber}`,
          );
        }

        // TODO(ASSUMPTION): If weights are given there must be one per bag.
        if (weights.length > 0 && weights.length !== count) {
          throw new BadRequestException(
            `Give one weight per extra bag for ${passenger.fullName}`,
          );
        }

        const tooHeavy = weights.find((w) => w > segment.cabin.maxWeightPerBagKg);

        if (tooHeavy !== undefined) {
          throw new BadRequestException(
            `Each extra bag on flight ${segment.flight.flightNumber} may weigh at most ${segment.cabin.maxWeightPerBagKg} kg`,
          );
        }

        currencies.add(policy.currency);

        const fee = round2(count * policy.pricePerExtraBag);
        segment.baggageSubtotal = round2(segment.baggageSubtotal + fee);
        extraBags.push({
          direction: segment.direction,
          count,
          weightsKg: weights,
          fee,
        });
      }

      return {
        fullName: passenger.fullName,
        dateOfBirth: passenger.dateOfBirth,
        documentNumber: passenger.documentNumber,
        passengerType,
        extraBags,
      };
    });

    // PAY-04: One platform currency
    if (currencies.size > 1) {
      throw new BadRequestException(
        `All prices in one booking must use the same currency (found ${[...currencies].join(', ')})`,
      );
    }

    // PAY-04: ...and it must be the platform currency (config payments.currency).
    // Baggage currency only counts when extra bags are bought, because only
    // then does the baggage policy's price enter the booking.
    const foreign = [...currencies].filter(
      (currency) => currency.toLowerCase() !== this.platformCurrency,
    );

    if (foreign.length > 0) {
      throw new BadRequestException(
        `Prices must be in the platform currency ${this.platformCurrency.toUpperCase()} (found ${foreign.join(', ')})`,
      );
    }

    const fareTotal = round2(
      segments.reduce((sum, s) => sum + s.fare.fareSubtotal, 0),
    );
    const baggageTotal = round2(
      segments.reduce((sum, s) => sum + s.baggageSubtotal, 0),
    );

    return {
      segments,
      passengers,
      counts,
      fareTotal,
      baggageTotal,
      totalPrice: round2(fareTotal + baggageTotal),
      currency: segments[0].cabin.currency,
      cancellationTiers: (cancellationPolicy?.tiers ?? []).map((tier) => ({
        daysBeforeDeparture: tier.daysBeforeDeparture,
        refundPercentage: tier.refundPercentage,
      })),
      cancellationPolicyDescription: cancellationPolicy?.description ?? '',
      timeZones,
    };
  }

  private baggageFor(
    passenger: FlightPassengerDto,
    direction: SegmentDirection,
  ): PassengerBaggageDto | undefined {
    return direction === SegmentDirection.OUTBOUND
      ? passenger.outboundBaggage
      : passenger.returnBaggage;
  }

  // Confirmed -> Cancelled in one transaction, with seats returned
  private async cancelConfirmedBooking(
    bookingId: Types.ObjectId,
    options: {
      cancelledBy: FlightCancelledBy;
      refundPercentage: number;
      refundAmount: number;
      userId?: Types.ObjectId;
      mustDepartAfter?: Date;
    },
    now: Date,
  ): Promise<FlightBookingRecord | null> {
    return this.connection.transaction(async (session) => {
      const filter: Record<string, unknown> = {
        _id: bookingId,
        status: FlightBookingStatus.CONFIRMED,
      };

      if (options.userId) {
        filter.userId = options.userId;
      }

      // FLT-26: Users cannot cancel after departure
      if (options.mustDepartAfter) {
        filter.outboundDepartureTime = { $gt: options.mustDepartAfter };
      }

      const cancelled = await this.bookingModel
        .findOneAndUpdate(
          filter,
          {
            $set: {
              status: FlightBookingStatus.CANCELLED,
              cancelledAt: now,
              cancelledBy: options.cancelledBy,
              refundPercentage: options.refundPercentage,
              refundAmount: options.refundAmount,
              // PAY-03: Refund status itself lives on the Payment record
              refundRequestedAt: options.refundAmount > 0 ? now : null,
            },
          },
          { new: true, session },
        )
        .lean<FlightBookingRecord>()
        .exec();

      if (!cancelled) {
        return null;
      }

      await this.releaseSeats(cancelled.segments, session);
      return cancelled;
    });
  }

  // FLT-06: Airline cancellation refunds after the booking is cancelled (the
  // flight is gone either way). A failure marks the Payment refund Failed, so
  // the user can retry with POST /flight-bookings/:id/cancel.
  private async requestRefund(booking: FlightBookingRecord): Promise<void> {
    if (!booking.refundAmount || booking.refundAmount <= 0) {
      return;
    }

    try {
      await this.payments.refund(String(booking._id), booking.refundAmount);
    } catch (error) {
      this.logger.error(
        `Refund request failed for flight booking ${String(booking._id)}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  // PAY-03: Request a refund; Stripe errors or a Failed refund become 502 so
  // the caller's booking stays unchanged and the user can retry.
  private async requestRefundOrThrow(
    bookingId: string,
    amount: number,
    message: string,
  ): Promise<FlightRefundResult> {
    let result: FlightRefundResult;

    try {
      result = await this.payments.refund(bookingId, amount);
    } catch (error) {
      this.logger.error(
        `Refund request failed for flight booking ${bookingId}`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new BadGatewayException(message);
    }

    if (result.status === 'Failed') {
      throw new BadGatewayException(message);
    }

    return result;
  }

  // PAY-01: Best effort, after the expiry transaction. If it fails, a payment
  // that still succeeds is refunded in full by the webhook.
  private async cancelPendingPaymentsSafely(bookingId: string): Promise<void> {
    try {
      await this.payments.cancelPendingPayments(bookingId);
    } catch (error) {
      this.logger.error(
        `Could not cancel PaymentIntents of expired flight booking ${bookingId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async releaseSeats(
    segments: FlightBookingSegment[],
    session: ClientSession,
  ): Promise<void> {
    for (const segment of segments) {
      await this.inventoryModel
        .updateOne(
          { _id: segment.cabinId },
          { $inc: { availableSeats: segment.seats } },
          { session },
        )
        .exec();
    }
  }

  // Owner-only load: someone else's booking is reported as not found
  private async loadOwned(
    userId: string,
    bookingId: string,
  ): Promise<FlightBookingRecord> {
    this.assertObjectId(bookingId, 'booking');
    this.assertObjectId(userId, 'user');

    const booking = await this.bookingModel
      .findOne({
        _id: new Types.ObjectId(bookingId),
        userId: new Types.ObjectId(userId),
      })
      .lean<FlightBookingRecord>()
      .exec();

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    return booking;
  }

  // FLT-29: Moderator of the flight's airline (airlineId from the DB), or admin
  private async loadManagedFlight(
    userId: string,
    flightId: string,
  ): Promise<FlightRecord> {
    this.assertObjectId(flightId, 'flight');
    this.assertObjectId(userId, 'user');

    const [flight, user] = await Promise.all([
      this.flightModel.findById(flightId).lean<FlightRecord>().exec(),
      this.userModel
        .findById(userId)
        .select({
          role: 1,
          airlineId: 1,
          isActive: 1,
          isSuspended: 1,
          deactivatedAt: 1,
        })
        .lean<{
          role: UserRole;
          airlineId?: string | null;
          isActive: boolean;
          isSuspended: boolean;
          deactivatedAt?: Date | null;
        }>()
        .exec(),
    ]);

    if (!user || !user.isActive || user.isSuspended || user.deactivatedAt) {
      throw new ForbiddenException('Account is unavailable');
    }

    if (!flight) {
      throw new NotFoundException('Flight not found');
    }

    if (user.role === UserRole.ADMIN) {
      return flight;
    }

    if (
      user.role !== UserRole.MODERATOR ||
      !user.airlineId ||
      user.airlineId !== String(flight.airlineId)
    ) {
      throw new ForbiddenException(
        'You can only view bookings for flights of your own airline',
      );
    }

    return flight;
  }

  private isHoldTimeOver(booking: FlightBookingRecord, now: Date): boolean {
    return (
      booking.status === FlightBookingStatus.PENDING_PAYMENT &&
      !!booking.holdExpiresAt &&
      booking.holdExpiresAt <= now
    );
  }

  private segmentForFlight(
    booking: FlightBookingRecord,
    flightId: Types.ObjectId,
  ): FlightBookingSegment | undefined {
    return booking.segments.find(
      (segment) => String(segment.flightId) === String(flightId),
    );
  }

  private generateReference(): string {
    let code = '';
    for (let i = 0; i < REFERENCE_LENGTH; i++) {
      code += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
    }
    return `FB-${code}`;
  }

  private isDuplicateReferenceError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === 11000 &&
      JSON.stringify(
        (error as { keyPattern?: unknown }).keyPattern ?? {},
      ).includes('reference')
    );
  }

  private assertObjectId(value: string, label: string): void {
    if (!value || !Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label} ID`);
    }
  }

  private async loadTimeZones(
    bookings: FlightBookingRecord[],
  ): Promise<Map<string, string>> {
    const codes = [
      ...new Set(
        bookings.flatMap((b) =>
          b.segments.flatMap((s) => [s.departureAirport, s.arrivalAirport]),
        ),
      ),
    ];

    if (codes.length === 0) {
      return new Map();
    }

    const airports = await this.airportModel
      .find({ iataCode: { $in: codes } })
      .select({ iataCode: 1, timeZone: 1 })
      .lean<{ iataCode: string; timeZone: string }[]>()
      .exec();

    return new Map(airports.map((a) => [a.iataCode, a.timeZone]));
  }

  // GEN-06: UTC times plus airport-local times with offset
  private segmentTimes(
    segment: {
      departureAirport: string;
      arrivalAirport: string;
      departureTime: Date;
      arrivalTime: Date;
    },
    timeZones: Map<string, string>,
  ) {
    const departureZone = timeZones.get(segment.departureAirport) ?? null;
    const arrivalZone = timeZones.get(segment.arrivalAirport) ?? null;

    return {
      departureAirport: segment.departureAirport,
      arrivalAirport: segment.arrivalAirport,
      departureTime: segment.departureTime.toISOString(),
      departureTimeLocal: departureZone
        ? formatLocalDateTime(segment.departureTime, departureZone)
        : null,
      departureTimeZone: departureZone,
      arrivalTime: segment.arrivalTime.toISOString(),
      arrivalTimeLocal: arrivalZone
        ? formatLocalDateTime(segment.arrivalTime, arrivalZone)
        : null,
      arrivalTimeZone: arrivalZone,
      durationMinutes: Math.round(
        (segment.arrivalTime.getTime() - segment.departureTime.getTime()) /
          60000,
      ),
    };
  }

  private toSegmentDocument(segment: QuoteSegment) {
    return {
      direction: segment.direction,
      flightId: segment.flight._id,
      airlineId: segment.flight.airlineId,
      cabinId: segment.cabin._id,
      flightNumber: segment.flight.flightNumber,
      departureAirport: segment.flight.departureAirport,
      arrivalAirport: segment.flight.arrivalAirport,
      departureTime: segment.flight.departureTime,
      arrivalTime: segment.flight.arrivalTime,
      cabinClass: segment.cabin.cabinClass,
      fare: segment.cabin.price,
      infantFare: segment.fare.infants.unitPrice,
      currency: segment.cabin.currency,
      seats: segment.fare.seats,
      freeBagsCount: segment.cabin.freeBagsCount,
      maxWeightPerBagKg: segment.cabin.maxWeightPerBagKg,
      pricePerExtraBag: segment.pricePerExtraBag,
      fareSubtotal: segment.fare.fareSubtotal,
      baggageSubtotal: segment.baggageSubtotal,
    };
  }

  private quoteSegmentResponse(
    segment: QuoteSegment,
    timeZones: Map<string, string>,
  ) {
    return {
      direction: segment.direction,
      flightId: segment.flight._id,
      flightNumber: segment.flight.flightNumber,
      airline: {
        id: segment.airline._id,
        name: segment.airline.name,
        code: segment.airline.code,
      },
      ...this.segmentTimes(segment.flight, timeZones),
      cabinClass: segment.cabin.cabinClass,
      seats: segment.fare.seats,
      freeBagsCount: segment.cabin.freeBagsCount,
      maxWeightPerBagKg: segment.cabin.maxWeightPerBagKg,
      pricePerExtraBag: segment.pricePerExtraBag,
      priceBreakdown: {
        adults: segment.fare.adults,
        children: segment.fare.children,
        infants: segment.fare.infants,
        fareSubtotal: segment.fare.fareSubtotal,
        baggageSubtotal: segment.baggageSubtotal,
      },
      currency: segment.cabin.currency,
    };
  }

  private toListItem(
    booking: FlightBookingRecord,
    timeZones: Map<string, string>,
  ) {
    const outbound = booking.segments[0];

    return {
      id: booking._id,
      reference: booking.reference ?? null,
      status: booking.status,
      tripType: booking.segments.length === 2 ? 'round-trip' : 'one-way',
      date: booking.outboundDepartureTime.toISOString(),
      cabinClass: outbound.cabinClass,
      segments: booking.segments.map((segment) => ({
        direction: segment.direction,
        flightNumber: segment.flightNumber,
        ...this.segmentTimes(segment, timeZones),
      })),
      passengers: booking.passengers.map((p) => ({
        fullName: p.fullName,
        passengerType: p.passengerType,
      })),
      totalPrice: booking.totalPrice,
      currency: booking.currency,
      holdExpiresAt: booking.holdExpiresAt,
    };
  }

  private toBookingResponse(
    booking: FlightBookingRecord,
    timeZones: Map<string, string>,
    now: Date,
    payment?: FlightPaymentSummary | null,
  ) {
    const passengerCounts = {
      adults: booking.adults,
      children: booking.children,
      infants: booking.infants,
    };

    return {
      id: booking._id,
      reference: booking.reference ?? null,
      status: booking.status,
      tripType: booking.segments.length === 2 ? 'round-trip' : 'one-way',
      holdExpiresAt: booking.holdExpiresAt,
      holdSecondsRemaining:
        booking.status === FlightBookingStatus.PENDING_PAYMENT &&
        booking.holdExpiresAt
          ? Math.max(
              0,
              Math.floor(
                (booking.holdExpiresAt.getTime() - now.getTime()) / 1000,
              ),
            )
          : null,
      policiesAcceptedAt: booking.policiesAcceptedAt,
      segments: booking.segments.map((segment) => ({
        direction: segment.direction,
        flightId: segment.flightId,
        flightNumber: segment.flightNumber,
        ...this.segmentTimes(segment, timeZones),
        cabinClass: segment.cabinClass,
        seats: segment.seats,
        freeBagsCount: segment.freeBagsCount,
        maxWeightPerBagKg: segment.maxWeightPerBagKg,
        priceBreakdown: {
          ...calculateSegmentFare(segment.fare, passengerCounts),
          baggageSubtotal: segment.baggageSubtotal,
        },
        currency: segment.currency,
      })),
      passengers: booking.passengers.map((p: FlightBookingPassenger) => ({
        fullName: p.fullName,
        dateOfBirth: new Date(p.dateOfBirth).toISOString().slice(0, 10),
        documentNumber: p.documentNumber,
        passengerType: p.passengerType,
        extraBags: p.extraBags,
      })),
      passengerCounts,
      fareTotal: booking.fareTotal,
      baggageTotal: booking.baggageTotal,
      totalPrice: booking.totalPrice,
      currency: booking.currency,
      cancellationPolicy: {
        description: booking.cancellationPolicyDescription,
        tiers: booking.cancellationTiers,
      },
      confirmedAt: booking.confirmedAt,
      cancelledAt: booking.cancelledAt,
      cancelledBy: booking.cancelledBy,
      refundPercentage: booking.refundPercentage,
      refundAmount: booking.refundAmount,
      refundRequestedAt: booking.refundRequestedAt ?? null,
      // PAY-01 / PAY-03: From the Payment record (single source of truth);
      // undefined where the caller did not load it.
      payment,
      createdAt: booking.createdAt,
    };
  }
}
