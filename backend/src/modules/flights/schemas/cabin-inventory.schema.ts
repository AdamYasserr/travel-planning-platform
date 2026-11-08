
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export type CabinInventoryDocument =
  HydratedDocument<CabinInventory>;

export enum CabinClass {
  ECONOMY = 'Economy',
  PREMIUM_ECONOMY = 'Premium Economy',
  BUSINESS = 'Business',
  FIRST = 'First',
}

@Schema({ timestamps: true })
export class CabinInventory {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Flight',
    required: true,
  })
  flightId: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(CabinClass),
    required: true,
  })
  cabinClass: CabinClass;

  @Prop({ required: true, min: 1 })
  totalSeats: number;

  @Prop({ required: true, min: 0 })
  availableSeats: number;

  @Prop({ required: true, min: 0.01 })
  price: number;

  @Prop({
    required: true,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 3,
  })
  currency: string;

  // FLT-04: Number of free bags for this cabin
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: Number.isInteger,
  })
  freeBagsCount: number;

  // FLT-04: Maximum weight permitted per bag
  @Prop({
    type: Number,
    required: true,
    min: 0.01,
  })
  maxWeightPerBagKg: number;
}

export const CabinInventorySchema =
  SchemaFactory.createForClass(CabinInventory);

CabinInventorySchema.index(
  { flightId: 1, cabinClass: 1 },
  { unique: true },
);

// Validate consistency when saving a document.
CabinInventorySchema.pre('save', function () {
  if (this.availableSeats > this.totalSeats) {
    throw new Error(
      'Available seats cannot exceed total seats',
    );
  }
});
