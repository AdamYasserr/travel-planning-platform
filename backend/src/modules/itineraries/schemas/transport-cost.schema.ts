import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema()
export class TransportCost {
  @Prop({ type: String, required: true, trim: true })
  mode: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'City',
    required: true,
  })
  fromCityId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'City',
    required: true,
  })
  toCityId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 3,
  })
  currency: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true })
  dayId: Types.ObjectId;
}

export const TransportCostSchema =
  SchemaFactory.createForClass(TransportCost);