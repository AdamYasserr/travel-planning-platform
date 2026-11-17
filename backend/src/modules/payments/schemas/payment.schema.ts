
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { PaymentStatus } from '../enums/payment-status.enum';
import { RefundStatus } from '../enums/refund-status.enum';

export type PaymentDocument = HydratedDocument<Payment>;

@Schema({ timestamps: true })
export class Payment {
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
    ref: 'HotelBooking',
    required: true,
    index: true,
  })
  hotelBookingId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    unique: true,
  })
  stripePaymentIntentId: string;

  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({ type: String, required: true, lowercase: true })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(PaymentStatus),
    default: PaymentStatus.PENDING,
    required: true,
    index: true,
  })
  status: PaymentStatus;

  @Prop({ type: String, enum: Object.values(RefundStatus) })
  refundStatus?: RefundStatus;

  @Prop({ type: String })
  stripeRefundId?: string;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

PaymentSchema.index({ userId: 1, createdAt: -1 });
PaymentSchema.index({ hotelBookingId: 1 });
