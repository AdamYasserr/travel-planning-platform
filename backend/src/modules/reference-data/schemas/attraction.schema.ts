import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AttractionDocument = HydratedDocument<Attraction>;

/** Dataset: Attractions.csv (attraction_id, name, city_id). */
@Schema()
export class Attraction {
  @Prop({ type: String, required: true, trim: true })
  attractionId: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  cityId: string;
}

export const AttractionSchema = SchemaFactory.createForClass(Attraction);
AttractionSchema.index({ attractionId: 1 }, { unique: true });
AttractionSchema.index({ cityId: 1, name: 1 });
