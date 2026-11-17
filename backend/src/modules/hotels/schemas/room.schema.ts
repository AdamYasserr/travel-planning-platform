import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';

export type RoomDocument = HydratedDocument<Room>;

@Schema({ _id: false })
export class RoomDateRange {
  @Prop({ type: Date, required: true })
  startDate: Date;

  @Prop({
    type: Date,
    required: true,
    validate: {
      validator: function (this: RoomDateRange, endDate: Date) {
        return endDate > this.startDate;
      },
      message: 'endDate must be after startDate',
    },
  })
  endDate: Date;
}

export const RoomDateRangeSchema =
  SchemaFactory.createForClass(RoomDateRange);

function rangesDoNotOverlap(ranges: RoomDateRange[]): boolean {
  const sortedRanges = [...ranges].sort(
    (a, b) =>
      new Date(a.startDate).getTime() - new Date(b.startDate).getTime(),
  );

  return sortedRanges.every((range, index) => {
    if (index === 0) {
      return true;
    }

    const previousRange = sortedRanges[index - 1];

    return (
      new Date(previousRange.endDate).getTime() <=
      new Date(range.startDate).getTime()
    );
  });
}

@Schema({ timestamps: true })
export class Room {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Hotel',
    required: true,
    index: true,
  })
  hotelId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  type: string;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: (value: number) => Number.isInteger(value),
      message: 'beds must be a whole number',
    },
  })
  beds: number;

  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: {
      validator: (value: number) => Number.isInteger(value),
      message: 'maxOccupancy must be a whole number',
    },
  })
  maxOccupancy: number;

  @Prop({
    type: Number,
    required: true,
    validate: {
      validator: (value: number) => value > 0,
      message: 'pricePerNight must be greater than 0',
    },
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
    type: [RoomDateRangeSchema],
    default: [],
    validate: {
      validator: rangesDoNotOverlap,
      message: 'Bookable date ranges must not overlap',
    },
  })
  availabilityRanges: RoomDateRange[];

  @Prop({ type: [RoomDateRangeSchema], default: [] })
  blockedRanges: RoomDateRange[];

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  /**
   * HTL-18 concurrency token. Every transaction that reserves, blocks, re-opens or removes
   * a room increments it, so two such transactions on the same room always write the same
   * document and MongoDB aborts one of them (write conflict) instead of letting both commit.
   */
  @Prop({ type: Number, default: 0 })
  holdSeq: number;
}

export const RoomSchema = SchemaFactory.createForClass(Room);

RoomSchema.index({ hotelId: 1, name: 1 }, { unique: true });
// HTL-11/15: the active rooms of a set of hotels.
RoomSchema.index({ hotelId: 1, isActive: 1 });
