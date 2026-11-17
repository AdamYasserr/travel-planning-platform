import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type CityDocument = HydratedDocument<City>;
@Schema({ timestamps: true })
export class City {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, required: true, trim: true, index: true }) sourceId: string;
  @Prop({ type: String, required: true, trim: true, index: true }) countryId: string;
}
export const CitySchema = SchemaFactory.createForClass(City);
CitySchema.index({ sourceId: 1 }, { unique: true }); CitySchema.index({ countryId: 1, name: 1 });
