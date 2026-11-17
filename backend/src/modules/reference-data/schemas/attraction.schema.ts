import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type AttractionDocument = HydratedDocument<Attraction>;
@Schema({ timestamps: true })
export class Attraction {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, required: true, trim: true, index: true }) sourceId: string;
  @Prop({ type: String, required: true, trim: true, index: true }) cityId: string;
  @Prop({ type: String, trim: true }) description?: string;
}
export const AttractionSchema = SchemaFactory.createForClass(Attraction);
AttractionSchema.index({ sourceId: 1 }, { unique: true }); AttractionSchema.index({ cityId: 1, name: 1 });
