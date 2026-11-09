import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

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
}

export const ItineraryActivitySchema =
  SchemaFactory.createForClass(ItineraryActivity);