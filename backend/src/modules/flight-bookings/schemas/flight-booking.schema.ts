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
}

export const FlightBookingPassengerSchema =
  SchemaFactory.createForClass(FlightBookingPassenger);

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

  @Prop({ type: Number, required: true, min: 0.01 })
  pricePerSeat: number;

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

FlightBookingSchema.index(
  { reference: 1 },
  { unique: true, sparse: true },
);
FlightBookingSchema.index({ flightId: 1, status: 1, holdExpiresAt: 1 });
