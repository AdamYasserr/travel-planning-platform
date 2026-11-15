import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

import {
  FlightBookingStatus,
  FlightCancelledBy,
  FlightRefundStatus,
  PassengerType,
  SegmentDirection,
} from '../enums/flight-booking-status.enum';
import { CabinClass } from '../../flights/schemas/cabin-inventory.schema';

export type FlightBookingDocument = HydratedDocument<FlightBooking>;

// FLT-12(a): One booked flight (outbound or return), with a price snapshot
@Schema({ _id: false })
export class FlightBookingSegment {
  @Prop({ type: String, enum: Object.values(SegmentDirection), required: true })
  direction: SegmentDirection;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Flight', required: true })
  flightId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Airline', required: true })
  airlineId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'CabinInventory', required: true })
  cabinId: Types.ObjectId;

  @Prop({ type: String, required: true })
  flightNumber: string;

  @Prop({ type: String, required: true })
  departureAirport: string;

  @Prop({ type: String, required: true })
  arrivalAirport: string;

  @Prop({ type: Date, required: true })
  departureTime: Date;

  @Prop({ type: Date, required: true })
  arrivalTime: Date;

  @Prop({ type: String, enum: Object.values(CabinClass), required: true })
  cabinClass: CabinClass;

  // Cabin fare per adult/child at hold time
  @Prop({ type: Number, required: true, min: 0.01 })
  fare: number;

  // FLT-12(b): 10% of the fare, rounded to 2 decimals
  @Prop({ type: Number, required: true, min: 0 })
  infantFare: number;

  @Prop({ type: String, required: true, uppercase: true })
  currency: string;

  // FLT-22: adults + children (infants take no seat)
  @Prop({ type: Number, required: true, min: 1 })
  seats: number;

  @Prop({ type: Number, required: true, min: 0 })
  freeBagsCount: number;

  @Prop({ type: Number, required: true, min: 0 })
  maxWeightPerBagKg: number;

  // FLT-08: Extra bag price at hold time (null if the airline has no policy)
  @Prop({ type: Number, default: null })
  pricePerExtraBag: number | null;

  @Prop({ type: Number, required: true, min: 0 })
  fareSubtotal: number;

  @Prop({ type: Number, required: true, min: 0 })
  baggageSubtotal: number;
}

export const FlightBookingSegmentSchema =
  SchemaFactory.createForClass(FlightBookingSegment);

// FLT-19 / FLT-08: Extra bags for one passenger on one segment
@Schema({ _id: false })
export class PassengerExtraBags {
  @Prop({ type: String, enum: Object.values(SegmentDirection), required: true })
  direction: SegmentDirection;

  @Prop({ type: Number, required: true, min: 1 })
  count: number;

  @Prop({ type: [Number], default: [] })
  weightsKg: number[];

  @Prop({ type: Number, required: true, min: 0 })
  fee: number;
}

export const PassengerExtraBagsSchema =
  SchemaFactory.createForClass(PassengerExtraBags);

// FLT-19: Passenger details
@Schema({ _id: false })
export class FlightBookingPassenger {
  @Prop({ type: String, required: true, trim: true })
  fullName: string;

  @Prop({ type: Date, required: true })
  dateOfBirth: Date;

  @Prop({ type: String, required: true, trim: true })
  documentNumber: string;

  // Derived from dateOfBirth at the outbound departure date
  @Prop({ type: String, enum: Object.values(PassengerType), required: true })
  passengerType: PassengerType;

  @Prop({ type: [PassengerExtraBagsSchema], default: [] })
  extraBags: PassengerExtraBags[];
}

export const FlightBookingPassengerSchema =
  SchemaFactory.createForClass(FlightBookingPassenger);

// FLT-09: Cancellation tier snapshot
@Schema({ _id: false })
export class FlightCancellationTierSnapshot {
  @Prop({ type: Number, required: true, min: 0 })
  daysBeforeDeparture: number;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  refundPercentage: number;
}

export const FlightCancellationTierSnapshotSchema =
  SchemaFactory.createForClass(FlightCancellationTierSnapshot);

@Schema({ timestamps: true })
export class FlightBooking {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({
    type: [FlightBookingSegmentSchema],
    required: true,
    validate: {
      validator: (segments: FlightBookingSegment[]) =>
        Array.isArray(segments) && segments.length >= 1 && segments.length <= 2,
      message: 'A flight booking must have one or two segments',
    },
  })
  segments: FlightBookingSegment[];

  // Denormalised from the outbound segment for expiry, completion and grouping
  @Prop({ type: Date, required: true })
  outboundDepartureTime: Date;

  @Prop({
    type: [FlightBookingPassengerSchema],
    required: true,
    validate: {
      validator: (passengers: FlightBookingPassenger[]) =>
        Array.isArray(passengers) &&
        passengers.some((p) => p.passengerType === PassengerType.ADULT),
      message: 'A flight booking must include at least one adult',
    },
  })
  passengers: FlightBookingPassenger[];

  @Prop({ type: Number, required: true, min: 1 })
  adults: number;

  @Prop({ type: Number, required: true, min: 0 })
  children: number;

  @Prop({ type: Number, required: true, min: 0 })
  infants: number;

  @Prop({ type: Number, required: true, min: 0 })
  fareTotal: number;

  @Prop({ type: Number, required: true, min: 0 })
  baggageTotal: number;

  @Prop({ type: Number, required: true, min: 0.01 })
  totalPrice: number;

  // PAY-04: One platform currency per booking
  @Prop({ type: String, required: true, uppercase: true })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(FlightBookingStatus),
    required: true,
    default: FlightBookingStatus.PENDING_PAYMENT,
    index: true,
  })
  status: FlightBookingStatus;

  // FLT-22: now + 10 minutes at hold time
  @Prop({ type: Date, default: null })
  holdExpiresAt: Date | null;

  // FLT-23: Generated on confirmation
  @Prop({ type: String, default: undefined })
  reference?: string;

  // PAY-02: null until the user accepts the policies
  @Prop({ type: Date, default: null })
  policiesAcceptedAt: Date | null;

  // FLT-09: Outbound airline's tiers copied at hold time
  @Prop({ type: [FlightCancellationTierSnapshotSchema], default: [] })
  cancellationTiers: FlightCancellationTierSnapshot[];

  @Prop({ type: String, default: '' })
  cancellationPolicyDescription: string;

  @Prop({ type: Date, default: null })
  confirmedAt: Date | null;

  @Prop({ type: String, default: null })
  paymentId: string | null;

  @Prop({ type: Date, default: null })
  expiredAt: Date | null;

  @Prop({ type: Date, default: null })
  completedAt: Date | null;

  @Prop({ type: Date, default: null })
  cancelledAt: Date | null;

  @Prop({ type: String, enum: [...Object.values(FlightCancelledBy), null], default: null })
  cancelledBy: FlightCancelledBy | null;

  @Prop({ type: Number, default: null })
  refundPercentage: number | null;

  @Prop({ type: Number, default: null })
  refundAmount: number | null;

  @Prop({ type: String, enum: [...Object.values(FlightRefundStatus), null], default: null })
  refundStatus: FlightRefundStatus | null;

  @Prop({ type: String, default: null })
  refundId: string | null;
}

export const FlightBookingSchema = SchemaFactory.createForClass(FlightBooking);

// FLT-23: Unique booking reference (only set once confirmed)
FlightBookingSchema.index({ reference: 1 }, { unique: true, sparse: true });

// FLT-22: Hold expiry job
FlightBookingSchema.index({ status: 1, holdExpiresAt: 1 });

// Completion job
FlightBookingSchema.index({ status: 1, outboundDepartureTime: 1 });

// FLT-25: A user's bookings
FlightBookingSchema.index({ userId: 1, outboundDepartureTime: 1 });

// FLT-29 / FLT-06: Bookings of a flight
FlightBookingSchema.index({ 'segments.flightId': 1, status: 1 });
