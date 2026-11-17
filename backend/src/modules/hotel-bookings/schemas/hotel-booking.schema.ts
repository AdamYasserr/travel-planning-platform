import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export type HotelBookingDocument = HydratedDocument<HotelBooking>;

export enum HotelBookingStatus {
  PENDING_PAYMENT = 'Pending Payment',
  CONFIRMED = 'Confirmed',
  COMPLETED = 'Completed',
  EXPIRED = 'Expired',
  CANCELLED = 'Cancelled',
}

@Schema({ _id: false })
export class HotelBookingRoom {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Room',
    required: true,
  })
  roomId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  roomName: string;

  @Prop({
    type: Number,
    required: true,
    min: 0.01,
  })
  pricePerNight: number;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    match: /^[A-Z]{3}$/,
  })
  currency: string;

  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: (value: number) => Number.isInteger(value),
      message: 'adults must be a whole number',
    },
  })
  adults: number;

  @Prop({
    type: [Number],
    default: [],
    validate: {
      validator: (ages: number[]) =>
        ages.every(
          (age) => Number.isInteger(age) && age >= 0 && age <= 17,
        ),
      message: 'childrenAges must contain whole-number ages from 0 to 17',
    },
  })
  childrenAges: number[];
}

export const HotelBookingRoomSchema =
  SchemaFactory.createForClass(HotelBookingRoom);

@Schema({ _id: false })
export class HotelCancellationTierSnapshot {
  @Prop({ type: Number, required: true, min: 0 })
  daysBeforeCheckIn: number;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  refundPercentage: number;
}

export const HotelCancellationTierSnapshotSchema =
  SchemaFactory.createForClass(HotelCancellationTierSnapshot);

@Schema({ timestamps: true })
export class HotelBooking {
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
    ref: 'Hotel',
    required: true,
    index: true,
  })
  hotelId: Types.ObjectId;

  @Prop({ type: Date, required: true })
  checkInDate: Date;

  @Prop({
    type: Date,
    required: true,
    validate: {
      validator: function (this: HotelBooking, value: Date) {
        return value > this.checkInDate;
      },
      message: 'checkOutDate must be after checkInDate',
    },
  })
  checkOutDate: Date;

  @Prop({
    type: [HotelBookingRoomSchema],
    required: true,
    validate: [
      {
        validator: (rooms: HotelBookingRoom[]) =>
          Array.isArray(rooms) && rooms.length > 0,
        message: 'A reservation must contain at least one room',
      },
      {
        validator: (rooms: HotelBookingRoom[]) =>
          Array.isArray(rooms) &&
          rooms.reduce((total, room) => total + room.adults, 0) >= 1,
        message: 'A reservation must include at least one adult',
      },
    ],
  })
  rooms: HotelBookingRoom[];

  @Prop({ type: Number, required: true, min: 0.01 })
  totalPrice: number;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    match: /^[A-Z]{3}$/,
  })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(HotelBookingStatus),
    required: true,
    default: HotelBookingStatus.PENDING_PAYMENT,
    index: true,
  })
  status: HotelBookingStatus;

  @Prop({ type: Date, default: null, index: true })
  holdExpiresAt?: Date | null;

  @Prop({ type: String, trim: true, default: undefined })
  reference?: string;

  // PAY-02: set when the user accepts the policies (at booking time or via accept-policies).
  @Prop({ type: Date, default: null })
  policiesAcceptedAt?: Date | null;

  @Prop({ type: String, required: true })
  checkInTime: string;

  @Prop({ type: String, required: true })
  checkOutTime: string;

  @Prop({
    type: [HotelCancellationTierSnapshotSchema],
    default: [],
  })
  cancellationTiers: HotelCancellationTierSnapshot[];

  @Prop({ type: Date, default: null })
  cancelledAt?: Date | null;

  @Prop({ type: Date, default: null })
  completedAt?: Date | null;
}

export const HotelBookingSchema =
  SchemaFactory.createForClass(HotelBooking);

HotelBookingSchema.index(
  { reference: 1 },
  { unique: true, sparse: true },
);

HotelBookingSchema.index({
  'rooms.roomId': 1,
  status: 1,
  checkInDate: 1,
  checkOutDate: 1,
});

HotelBookingSchema.index({
  hotelId: 1,
  status: 1,
  checkInDate: 1,
  checkOutDate: 1,
});
