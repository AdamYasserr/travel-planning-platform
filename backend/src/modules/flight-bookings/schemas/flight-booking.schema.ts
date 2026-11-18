import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

import { FlightBookingStatus } from '../enums/flight-booking-status.enum';
import { CabinClass } from '../../flights/schemas/cabin-inventory.schema';
import {
  CancellationTier,
  CancellationTierSchema,
} from '../../airlines/schemas/cancellation-policy.schema';

export type FlightBookingDocument = HydratedDocument<FlightBooking>;

@Schema({ _id: false })
export class FlightBookingPassenger {
  @Prop({ type: String, required: true, trim: true })
  fullName: string;

  @Prop({ type: Date, required: true })
  dateOfBirth: Date;

  // FLT-19: the fields below are required on new bookings (DTO) but optional here, so bookings made
  // before they existed still load.

  /** Derived from dateOfBirth on the outbound departure day, never sent by the client. */
  @Prop({ type: String, enum: ['adult', 'child', 'infant'], default: undefined })
  type?: 'adult' | 'child' | 'infant';

  @Prop({ type: String, trim: true, uppercase: true, default: undefined })
  passportNumber?: string;

  @Prop({ type: Date, default: undefined })
  passportExpiry?: Date;

  @Prop({ type: String, trim: true, default: undefined })
  nationalId?: string;

  /** Country code from the Countries reference list. */
  @Prop({ type: String, trim: true, uppercase: true, default: undefined })
  nationality?: string;
}

export const FlightBookingPassengerSchema =
  SchemaFactory.createForClass(FlightBookingPassenger);

/** One flight's share of the price, in major units of the booking currency (FLT-12, FLT-19). */
@Schema({ _id: false })
export class PricingSegment {
  @Prop({ type: String, enum: ['outbound', 'return'], required: true })
  direction: 'outbound' | 'return';

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Flight', required: true })
  flightId: Types.ObjectId;

  /** Cabin fare per seat. Adults and children pay it; an infant pays infantFare and takes no seat. */
  @Prop({ type: Number, required: true, min: 0 })
  fare: number;

  @Prop({ type: Number, required: true, min: 0 })
  infantFare: number;

  @Prop({ type: Number, required: true, min: 0 })
  seats: number;

  @Prop({ type: Number, required: true, min: 0 })
  infants: number;

  @Prop({ type: Number, required: true, min: 0 })
  subtotal: number;
}

export const PricingSegmentSchema = SchemaFactory.createForClass(PricingSegment);

@Schema({ _id: false })
export class BookingPricing {
  @Prop({ type: [PricingSegmentSchema], default: [] })
  segments: PricingSegment[];

  @Prop({ type: Number, required: true, min: 0 })
  total: number;
}

export const BookingPricingSchema = SchemaFactory.createForClass(BookingPricing);

@Schema({ _id: false })
export class BaggageSnapshot {
  @Prop({ type: Number, required: true, min: 0 })
  carryOnAllowanceKg: number;

  @Prop({ type: Number, required: true, min: 0 })
  checkedBaggageAllowanceKg: number;

  @Prop({ type: Number, required: true, min: 0 })
  pricePerExtraBag: number;

  @Prop({ type: Number, required: true, min: 0 })
  maxExtraBagsPerPassenger: number;

  @Prop({ type: String, required: true })
  currency: string;

  @Prop({ type: Number, required: true, min: 0 })
  freeBagsCount: number;

  @Prop({ type: Number, required: true, min: 0 })
  maxWeightPerBagKg: number;
}

export const BaggageSnapshotSchema = SchemaFactory.createForClass(BaggageSnapshot);

@Schema({ timestamps: true })
export class FlightBooking {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  userId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Flight',
    required: true,
    index: true,
  })
  flightId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  departureTime: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'CabinInventory',
    required: true,
  })
  cabinInventoryId: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(CabinClass),
    required: true,
  })
  cabinClass: CabinClass;

  @Prop({
    type: [FlightBookingPassengerSchema],
    required: true,
    validate: {
      validator: (passengers: FlightBookingPassenger[]) =>
        Array.isArray(passengers) && passengers.length > 0,
      message: 'A booking must include at least one passenger',
    },
  })
  passengers: FlightBookingPassenger[];

  /**
   * Seats held on each flight: adults + children (infants take no seat). Missing on bookings made
   * before infants were priced separately; those held one seat per passenger (see seatsHeld()).
   */
  @Prop({ type: Number, min: 1, default: undefined })
  seatCount?: number;

  @Prop({ type: Number, required: true, min: 0.01 })
  pricePerSeat: number;

  /** How totalPrice was computed. Missing on older bookings. */
  @Prop({ type: BookingPricingSchema, default: undefined })
  pricing?: BookingPricing;

  @Prop({ type: Number, required: true, min: 0.01 })
  totalPrice: number;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(FlightBookingStatus),
    required: true,
    default: FlightBookingStatus.PENDING_PAYMENT,
    index: true,
  })
  status: FlightBookingStatus;

  @Prop({ type: Date, default: null, index: true })
  holdExpiresAt?: Date | null;

  @Prop({ type: String, trim: true, default: undefined })
  reference?: string;

  // PAY-02: set when the user accepts the policies (at booking time or via accept-policies).
  @Prop({ type: Date, default: null })
  policiesAcceptedAt?: Date | null;

  // PAY-02: baggage terms shown to (and accepted by) the user, snapshotted like the cancellation tiers.
  @Prop({ type: BaggageSnapshotSchema, default: null })
  baggagePolicy?: BaggageSnapshot | null;

  @Prop({ type: [CancellationTierSchema], default: [] })
  cancellationTiers: CancellationTier[];

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;
}

export const FlightBookingSchema =
  SchemaFactory.createForClass(FlightBooking);

/** Seats a booking holds on each of its flights; older bookings held one per passenger. */
export function seatsHeld(booking: Pick<FlightBooking, 'seatCount' | 'passengers'>): number {
  return booking.seatCount ?? booking.passengers.length;
}

FlightBookingSchema.index(
  { reference: 1 },
  { unique: true, sparse: true },
);
FlightBookingSchema.index({ flightId: 1, status: 1, holdExpiresAt: 1 });
// FLT-29: the airline's per-flight list, newest first.
FlightBookingSchema.index({ flightId: 1, status: 1, createdAt: -1 });
