import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema, Types } from 'mongoose';

@Schema()
export class ItineraryActivity {
  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  description: string;

  @Prop({ type: String, trim: true })
  time?: string;

  @Prop({ type: Number, min: 0 })
  cost?: number;

  @Prop({
    type: String,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 3,
    match: /^[A-Z]{3}$/,
    required: function (this: ItineraryActivity) {
      return this.cost !== undefined && this.cost !== null;
    },
  })
  costCurrency?: string;

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Media',
    default: [],
  })
  imageIds: Types.ObjectId[];
}

export const ItineraryActivitySchema =
  SchemaFactory.createForClass(ItineraryActivity);