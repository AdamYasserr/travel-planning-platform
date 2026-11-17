import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { PaymentBookingType } from '../enums/payment-status.enum';

/** PAY-03: the three states of a refund. Refunded and Failed are final. */
export enum RefundRecordStatus {
  PENDING = 'Pending',
  REFUNDED = 'Refunded',
  FAILED = 'Failed',
}

export enum RefundReason {
  /** The user cancelled a Confirmed booking (tier on the booking). */
  BOOKING_CANCELLED = 'booking_cancelled',
  /** The airline (or an admin) cancelled the flight: 100% (FLT-06). */
  FLIGHT_CANCELLED = 'flight_cancelled',
  /** The payment succeeded after the hold expired: 100%. */
  LATE_PAYMENT = 'late_payment',
  /** The payment succeeded with an amount or currency that did not match the booking: 100%. */
  PAYMENT_MISMATCH = 'payment_mismatch',
}

export type RefundDocument = HydratedDocument<Refund>;

@Schema({ timestamps: true })
export class Refund {
  declare _id: Types.ObjectId;
  declare createdAt: Date;
  declare updatedAt: Date;

  /** One refund per payment, ever: this unique index is what makes refunds idempotent. */
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Payment', required: true, unique: true })
  paymentId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(PaymentBookingType), required: true })
  bookingType: PaymentBookingType;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  bookingId: Types.ObjectId;

  /** Stripe minor units, never more than was paid. */
  @Prop({ type: Number, required: true, min: 1 })
  amountMinor: number;

  @Prop({ type: String, required: true, lowercase: true, trim: true })
  currency: string;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  percentage: number;

  @Prop({ type: String, enum: Object.values(RefundReason), required: true })
  reason: RefundReason;

  @Prop({ type: String, enum: Object.values(RefundRecordStatus), required: true, default: RefundRecordStatus.PENDING, index: true })
  status: RefundRecordStatus;

  @Prop({ type: String, default: undefined, unique: true, sparse: true })
  stripeRefundId?: string;

  @Prop({ type: String, default: null })
  failureCode?: string | null;

  @Prop({ type: Date, default: null })
  refundedAt?: Date | null;

  @Prop({ type: Date, default: null })
  failedAt?: Date | null;

  /** Short lease taken by whoever is calling Stripe, so two job runs never call it for the same refund. */
  @Prop({ type: Date, default: null })
  lockedUntil?: Date | null;
}

export const RefundSchema = SchemaFactory.createForClass(Refund);
RefundSchema.index({ status: 1, stripeRefundId: 1, lockedUntil: 1 });
