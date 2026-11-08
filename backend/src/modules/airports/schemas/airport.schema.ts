
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AirportDocument = HydratedDocument<Airport>;

@Schema({ timestamps: true })
export class Airport {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, uppercase: true, trim: true })
  iataCode: string;

  @Prop({ trim: true })
  city: string;

  @Prop({ trim: true })
  country: string;

  @Prop({ required: true, trim: true })
  timeZone: string;
}

export const AirportSchema = SchemaFactory.createForClass(Airport);

AirportSchema.index({ iataCode: 1 }, { unique: true });
