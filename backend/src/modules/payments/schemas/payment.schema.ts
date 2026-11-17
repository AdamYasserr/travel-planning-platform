import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

import {
  PaymentBookingType,
  PaymentStatus,
} from '../enums/payment-status.enum';
import { RefundStatus } from '../enums/refund-status.enum';

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({ timestamps: true })
export class Payment {
  declare _id: Types.ObjectId;
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
    type: String,
    enum: Object.values(PaymentBookingType),
    required: true,
  })
  bookingType: PaymentBookingType;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  amountMinor: number;

  @Prop({ type: String, required: true, lowercase: true, trim: true })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    required: true,
    default: PaymentStatus.PENDING,
    index: true,
  })
  status: PaymentStatus;

  @Prop({ type: Date, required: true })
  holdExpiresAt: Date;

  // PAY-01: only the PaymentIntent id, amount, currency and status are stored. Never card data or the client secret.
  @Prop({ type: String, default: undefined, unique: true, sparse: true })
  stripePaymentIntentId?: string;

  @Prop({ type: String, default: undefined })
  lastFailureCode?: string;

  @Prop({ type: Number, default: 0, min: 0 })
  refundAmountMinor: number;

  @Prop({ type: Number, default: 0, min: 0, max: 100 })
  refundPercentage: number;

  @Prop({
    type: String,
    enum: Object.values(RefundStatus),
    default: RefundStatus.NOT_REQUIRED,
  })
  refundStatus: RefundStatus;

  @Prop({ type: String, default: undefined, unique: true, sparse: true })
  stripeRefundId?: string;

  @Prop({ type: Date, default: null })
  refundRequestedAt?: Date | null;

  @Prop({ type: Date, default: null })
  refundedAt?: Date | null;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index(
  { bookingType: 1, bookingId: 1 },
  { unique: true },
);
PaymentSchema.index({ status: 1, holdExpiresAt: 1 });

export enum StripeWebhookEventStatus {
  PROCESSING = 'Processing',
  PROCESSED = 'Processed',
}

@Schema({ timestamps: true })
export class StripeWebhookEvent {
  @Prop({ type: String, required: true, unique: true, index: true })
  stripeEventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Payment',
    default: null,
  })
  paymentId?: Types.ObjectId | null;

  @Prop({
    type: String,
    enum: Object.values(StripeWebhookEventStatus),
    required: true,
    default: StripeWebhookEventStatus.PROCESSING,
  })
  status: StripeWebhookEventStatus;

  @Prop({ type: Date, default: null })
  processedAt?: Date | null;
}

export const StripeWebhookEventSchema =
  SchemaFactory.createForClass(StripeWebhookEvent);
