import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { FlightBookingStatus } from '../flight-bookings/enums/flight-booking-status.enum';
import { FlightBooking } from '../flight-bookings/schemas/flight-booking.schema';
import { HotelBooking, HotelBookingStatus } from '../hotel-bookings/schemas/hotel-booking.schema';
import { PaymentBookingType } from './enums/payment-status.enum';
import { PaymentsService } from './payments.service';

/**
 * PAY-02: the provider policies shown before payment, and the stored acceptance.
 * Hotel and flight bookings snapshot their policies at creation, so what the user sees (and accepts)
 * cannot change afterwards.
 */
@Injectable()
export class BookingPoliciesService {
  constructor(
    @InjectModel(HotelBooking.name) private readonly hotelBookings: Model<HotelBooking>,
    @InjectModel(FlightBooking.name) private readonly flightBookings: Model<FlightBooking>,
    private readonly payments: PaymentsService,
  ) {}

  async get(userId: string, type: PaymentBookingType, bookingId: string) {
    const booking = await this.findOwned(userId, type, bookingId);
    return this.present(type, booking);
  }

  async accept(userId: string, type: PaymentBookingType, bookingId: string) {
    const booking = await this.findOwned(userId, type, bookingId);
    const pending =
      type === PaymentBookingType.HOTEL ? HotelBookingStatus.PENDING_PAYMENT : FlightBookingStatus.PENDING_PAYMENT;
    if (booking.status !== pending) {
      throw new ConflictException('Policies can only be accepted while the booking is Pending Payment');
    }
    const now = new Date();
    if (!booking.holdExpiresAt || booking.holdExpiresAt <= now) {
      await this.payments.expireHoldIfDue(type, String(booking._id));
      throw new ConflictException('The booking hold has expired');
    }
    // Idempotent: a second call keeps the first timestamp.
    if (!booking.policiesAcceptedAt) {
      const model = (type === PaymentBookingType.HOTEL ? this.hotelBookings : this.flightBookings) as Model<any>;
      await model
        .updateOne(
          { _id: booking._id, userId: booking.userId, status: pending, policiesAcceptedAt: null, holdExpiresAt: { $gt: now } },
          { $set: { policiesAcceptedAt: now } },
        )
        .exec();
    }
    return this.present(type, await this.findOwned(userId, type, bookingId));
  }

  private async findOwned(userId: string, type: PaymentBookingType, bookingId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid booking ID');
    }
    const filter = { _id: new Types.ObjectId(bookingId), userId: new Types.ObjectId(userId) };
    const booking =
      type === PaymentBookingType.HOTEL
        ? await this.hotelBookings.findOne(filter).lean().exec()
        : await this.flightBookings.findOne(filter).lean().exec();
    if (!booking) throw new NotFoundException('Booking not found');
    return booking as (HotelBooking | FlightBooking) & { _id: Types.ObjectId };
  }

  private present(type: PaymentBookingType, booking: (HotelBooking | FlightBooking) & { _id: Types.ObjectId }) {
    const base = {
      bookingType: type,
      bookingId: booking._id,
      status: booking.status,
      holdExpiresAt: booking.holdExpiresAt ?? null,
      accepted: !!booking.policiesAcceptedAt,
      policiesAcceptedAt: booking.policiesAcceptedAt ?? null,
    };
    if (type === PaymentBookingType.HOTEL) {
      const hotel = booking as HotelBooking;
      return {
        ...base,
        policies: {
          cancellation: {
            tiers: (hotel.cancellationTiers ?? []).map((t) => ({
              daysBeforeCheckIn: t.daysBeforeCheckIn,
              refundPercentage: t.refundPercentage,
            })),
          },
          checkInTime: hotel.checkInTime,
          checkOutTime: hotel.checkOutTime,
        },
      };
    }
    const flight = booking as FlightBooking;
    const baggage = flight.baggagePolicy;
    return {
      ...base,
      policies: {
        cancellation: {
          tiers: (flight.cancellationTiers ?? []).map((t) => ({
            daysBeforeDeparture: t.daysBeforeDeparture,
            refundPercentage: t.refundPercentage,
          })),
        },
        baggage: baggage
          ? {
              carryOnAllowanceKg: baggage.carryOnAllowanceKg,
              checkedBaggageAllowanceKg: baggage.checkedBaggageAllowanceKg,
              freeBagsCount: baggage.freeBagsCount,
              maxWeightPerBagKg: baggage.maxWeightPerBagKg,
              pricePerExtraBag: baggage.pricePerExtraBag,
              maxExtraBagsPerPassenger: baggage.maxExtraBagsPerPassenger,
              currency: baggage.currency,
            }
          : null,
      },
    };
  }
}
