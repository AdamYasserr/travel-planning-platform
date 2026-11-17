import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model, Types } from 'mongoose';

import { CabinInventory, CabinClass } from '../flights/schemas/cabin-inventory.schema';
import { Flight, FlightStatus } from '../flights/schemas/flight.schema';
import { BaggagePolicy } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy } from '../airlines/schemas/cancellation-policy.schema';
import {
  CreateFlightBookingDto,
  FlightBookingPassengerDto,
} from './dto/flight-bookings.dto';
import { FlightBookingStatus } from './enums/flight-booking-status.enum';
import { FlightBooking } from './schemas/flight-booking.schema';
import { PaymentsService } from '../payments/payments.service';
import { PaymentBookingType } from '../payments/enums/payment-status.enum';
import { BOOKING_HOLD_DURATION_MS } from '../../common/booking/booking-hold';

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
  ) {}

  async create(userId: string, dto: CreateFlightBookingDto) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(dto.flightId)) {
      throw new BadRequestException('Invalid user or flight ID');
    }
    this.validatePassengers(dto.passengers);

    const flightId = new Types.ObjectId(dto.flightId);
    const now = new Date();
    const flight = await this.flightModel
      .findOne({
        _id: flightId,
        status: FlightStatus.SCHEDULED,
        departureTime: { $gt: now },
      })
      .exec();
    if (!flight) {
      throw new ConflictException('Flight is not available for booking');
    }

    const inventory = await this.inventoryModel
      .findOne({ flightId, cabinClass: dto.cabinClass })
      .exec();
    if (!inventory) {
      throw new NotFoundException('Cabin inventory not found for this flight');
    }

    const cancellationPolicy = await this.cancellationPolicyModel
      .findOne({ airlineId: flight.airlineId })
      .lean()
      .exec();

    const baggagePolicy = await this.baggagePolicyModel
      .findOne({ airlineId: flight.airlineId })
      .lean()
      .exec();

    await this.paymentsService.expireFlightHoldsForInventory(inventory._id);
    const reservedInventory = await this.inventoryModel
      .findOneAndUpdate(
        {
          _id: inventory._id,
          flightId,
          availableSeats: { $gte: dto.passengers.length },
        },
        { $inc: { availableSeats: -dto.passengers.length } },
        { new: true },
      )
      .exec();
    if (!reservedInventory) {
      throw new ConflictException('Not enough seats are available');
    }

    const pricePerSeat = reservedInventory.price;
    const bookingData = {
      userId: new Types.ObjectId(userId),
      flightId,
      departureTime: flight.departureTime,
      cabinInventoryId: reservedInventory._id,
      cabinClass: dto.cabinClass as CabinClass,
      passengers: dto.passengers.map((passenger) => ({
        fullName: passenger.fullName.trim(),
        dateOfBirth: new Date(`${passenger.dateOfBirth}T00:00:00.000Z`),
      })),
      pricePerSeat,
      totalPrice: pricePerSeat * dto.passengers.length,
      currency: reservedInventory.currency,
      status: FlightBookingStatus.PENDING_PAYMENT,
      holdExpiresAt: new Date(now.getTime() + BOOKING_HOLD_DURATION_MS),
      reference: `FLT-${randomUUID()}`,
      policiesAcceptedAt: dto.policiesAccepted === true ? now : null,
      baggagePolicy: baggagePolicy
        ? {
            carryOnAllowanceKg: baggagePolicy.carryOnAllowanceKg,
            checkedBaggageAllowanceKg: baggagePolicy.checkedBaggageAllowanceKg,
            pricePerExtraBag: baggagePolicy.pricePerExtraBag,
            maxExtraBagsPerPassenger: baggagePolicy.maxExtraBagsPerPassenger,
            currency: baggagePolicy.currency,
            freeBagsCount: reservedInventory.freeBagsCount,
            maxWeightPerBagKg: reservedInventory.maxWeightPerBagKg,
          }
        : null,
      cancellationTiers: [...(cancellationPolicy?.tiers ?? [])]
        .sort((a, b) => b.daysBeforeDeparture - a.daysBeforeDeparture)
        .map((tier) => ({
          daysBeforeDeparture: tier.daysBeforeDeparture,
          refundPercentage: tier.refundPercentage,
        })),
    };

    try {
      return await this.bookingModel.create(bookingData);
    } catch (error) {
      await this.inventoryModel
        .updateOne(
          { _id: reservedInventory._id },
          { $inc: { availableSeats: dto.passengers.length } },
        )
        .exec();
      throw error;
    }
  }

  async listForUser(userId: string, page = 1, limit = 10) {
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException('Invalid user ID');
    }
    await this.paymentsService.expireFlightHoldsForUser(userId);
    const filter = { userId: new Types.ObjectId(userId) };
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

  private validatePassengers(passengers: FlightBookingPassengerDto[]) {
    if (!Array.isArray(passengers) || passengers.length === 0) {
      throw new BadRequestException('A booking must include at least one passenger');
    }
    const now = new Date();
    if (
      passengers.some((passenger) => {
        const date = new Date(`${passenger.dateOfBirth}T00:00:00.000Z`);
        return (
          !passenger.fullName?.trim() ||
          !Number.isFinite(date.getTime()) ||
          date >= now
        );
      })
    ) {
      throw new BadRequestException('Passenger details are invalid');
    }
  }

  private validateBookingId(userId: string, bookingId: string) {
    if (!Types.ObjectId.isValid(userId) || !Types.ObjectId.isValid(bookingId)) {
      throw new BadRequestException('Invalid user or booking ID');
    }
  }

}
