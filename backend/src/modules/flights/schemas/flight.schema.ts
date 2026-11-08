
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export type FlightDocument = HydratedDocument<Flight>;

export enum FlightStatus {
  SCHEDULED = 'Scheduled',
  CANCELLED = 'Cancelled',
  DEPARTED = 'Departed',
}

@Schema({ timestamps: true })
export class Flight {
  @Prop({ required: true, trim: true })
  flightNumber: string;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Airline',
    required: true,
  })
  airlineId: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true })
  departureAirport: string;

  @Prop({ required: true, uppercase: true, trim: true })
  arrivalAirport: string;

  @Prop({ required: true, type: Date })
  departureTime: Date;

  @Prop({ required: true, type: Date })
  arrivalTime: Date;

  @Prop({
    type: String,
    enum: Object.values(FlightStatus),
    default: FlightStatus.SCHEDULED,
  })
  status: FlightStatus;
}

export const FlightSchema = SchemaFactory.createForClass(Flight);
