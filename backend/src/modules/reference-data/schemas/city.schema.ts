import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CityDocument = HydratedDocument<City>;

/** Dataset: Cities.csv (city_id, name, country_code). `cityId` is the public identifier. */
@Schema()
export class City {
  @Prop({ type: String, required: true, trim: true })
  cityId: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true, uppercase: true })
  countryCode: string;
}

export const CitySchema = SchemaFactory.createForClass(City);
CitySchema.index({ cityId: 1 }, { unique: true });
CitySchema.index({ countryCode: 1, name: 1 });
