
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export type BaggagePolicyDocument =
  HydratedDocument<BaggagePolicy>;

@Schema({ timestamps: true })
export class BaggagePolicy {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Airline',
    required: true,
    unique: true,
  })
  airlineId: Types.ObjectId;

  @Prop({ required: true, min: 0 })
  carryOnAllowanceKg: number;

  @Prop({ required: true, min: 0 })
  checkedBaggageAllowanceKg: number;

  // FLT-08: Price for each extra bag
  @Prop({ required: true, min: 0.01 })
  pricePerExtraBag: number;

  // FLT-08: Maximum number of extra bags per passenger
  @Prop({ required: true, min: 0 })
  maxExtraBagsPerPassenger: number;

  @Prop({
    required: true,
    uppercase: true,
    trim: true,
  })
  currency: string;
}

export const BaggagePolicySchema =
  SchemaFactory.createForClass(BaggagePolicy);
