import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';
import { ItineraryVisibility } from '../enums/itinerary-visibility.enum';
import { ItineraryDay, ItineraryDaySchema } from './day.schema';
import {
  TransportCost,
  TransportCostSchema,
} from './transport-cost.schema';

export type ItineraryDocument = HydratedDocument<Itinerary>;

function daysAreWithinLimitAndSequential(days: ItineraryDay[]): boolean {
  return (
    Array.isArray(days) &&
    days.length <= 60 &&
    days.every((day, index) => day.dayNumber === index + 1)
  );
}

@Schema({ timestamps: true })
export class Itinerary {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  ownerId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
  })
  title: string;

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Country',
    required: true,
    validate: {
      validator: (countryIds: Types.ObjectId[]) =>
        Array.isArray(countryIds) && countryIds.length > 0,
      message: 'At least one country is required',
    },
  })
  countryIds: Types.ObjectId[];

  @Prop({ type: Date, required: true })
  startDate: Date;

  @Prop({
    type: [ItineraryDaySchema],
    default: [],
    validate: {
      validator: daysAreWithinLimitAndSequential,
      message:
        'An itinerary can have at most 60 days numbered sequentially from 1',
    },
  })
  days: ItineraryDay[];

  @Prop({ type: [TransportCostSchema], default: [] })
  transportCosts: TransportCost[];

  @Prop({
    type: String,
    enum: Object.values(ItineraryVisibility),
    default: ItineraryVisibility.PRIVATE,
    required: true,
    index: true,
  })
  visibility: ItineraryVisibility;
}

export const ItinerarySchema = SchemaFactory.createForClass(Itinerary);