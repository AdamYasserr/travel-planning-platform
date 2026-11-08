
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AirlineDocument = HydratedDocument<Airline>;

@Schema({ timestamps: true })
export class Airline {
  @Prop({ required: true, trim: true })
  name: string;

  @Prop({ required: true, uppercase: true, trim: true, unique: true })
  code: string;

  @Prop({ default: true })
  isActive: boolean;
}

export const AirlineSchema = SchemaFactory.createForClass(Airline);
