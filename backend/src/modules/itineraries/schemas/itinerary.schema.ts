import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Schema as MongooseSchema, Types } from "mongoose";
import { ItineraryVisibility } from "../enums/itinerary-visibility.enum";
import { ItineraryDay, ItineraryDaySchema } from "./day.schema";
import { TransportCost, TransportCostSchema } from "./transport-cost.schema";

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
    ref: "User",
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
    type: [String],
    required: true,
    validate: {
      validator: (countryIds: string[]) =>
        Array.isArray(countryIds) && countryIds.length > 0,
      message: "At least one country is required",
    },
  })
  /** Dataset country codes, e.g. ["EG"] */
  countryIds: string[];

  @Prop({ type: Date, default: null })
  endDate?: Date | null;

  @Prop({ type: Date, required: true })
  startDate: Date;

  @Prop({
    type: [ItineraryDaySchema],
    default: [],
    validate: {
      validator: daysAreWithinLimitAndSequential,
      message:
        "An itinerary can have at most 60 days numbered sequentially from 1",
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

  @Prop({
    type: String,
    default: "USD",
    uppercase: true,
    trim: true,
    match: /^[A-Z]{3}$/,
  })
  displayCurrency: string;

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: "HotelBooking",
    default: [],
  })
  hotelBookingIds: Types.ObjectId[];

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: "FlightBooking",
    default: [],
  })
  flightBookingIds: Types.ObjectId[];
}

export const ItinerarySchema = SchemaFactory.createForClass(Itinerary);

// ITN-20: the public search (visibility first, then the filter fields).
ItinerarySchema.index({ visibility: 1, createdAt: -1 });
ItinerarySchema.index({ visibility: 1, startDate: 1 });
ItinerarySchema.index({ visibility: 1, "days.cityId": 1 });
ItinerarySchema.index({ visibility: 1, countryIds: 1 });
