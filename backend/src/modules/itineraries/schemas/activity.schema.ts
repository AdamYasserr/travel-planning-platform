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

  /** ITN-12: Media documents of this activity's images (at most 5), see MediaService. */
  @Prop({ type: [MongooseSchema.Types.ObjectId], default: [] })
  mediaIds: Types.ObjectId[];
}

export const ItineraryActivitySchema =
  SchemaFactory.createForClass(ItineraryActivity);