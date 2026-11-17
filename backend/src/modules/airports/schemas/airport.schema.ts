import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AirportDocument = HydratedDocument<Airport>;

export function isValidTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Dataset: Airports.csv (iata_code, name, city_id, country_code, time_zone). `iataCode` is the public identifier. */
@Schema()
export class Airport {
  @Prop({ type: String, required: true, uppercase: true, trim: true })
  iataCode: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  cityId: string;

  @Prop({ type: String, required: true, uppercase: true, trim: true })
  countryCode: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    validate: { validator: isValidTimeZone, message: 'timeZone must be a valid IANA timezone identifier' },
  })
  timeZone: string;
}

export const AirportSchema = SchemaFactory.createForClass(Airport);
AirportSchema.index({ iataCode: 1 }, { unique: true });
AirportSchema.index({ cityId: 1 });
AirportSchema.index({ countryCode: 1 });
