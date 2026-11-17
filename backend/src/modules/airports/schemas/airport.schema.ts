import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type AirportDocument = HydratedDocument<Airport>;
@Schema({ timestamps: true })
export class Airport {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, required: true, uppercase: true, trim: true, index: true }) iataCode: string;
  @Prop({ type: String, trim: true, index: true }) city: string;
  @Prop({ type: String, trim: true, index: true }) country: string;
  @Prop({ type: String, required: true, trim: true, validate: { validator: (value: string) => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, message: 'timeZone must be a valid IANA timezone identifier' } }) timeZone: string;
  @Prop({ type: String, trim: true, index: true }) sourceId?: string;
  @Prop({ type: String, trim: true }) cityId?: string;
  @Prop({ type: String, trim: true }) countryId?: string;
}
export const AirportSchema = SchemaFactory.createForClass(Airport);
AirportSchema.index({ iataCode: 1 }, { unique: true });
AirportSchema.index({ sourceId: 1 }, { unique: true, sparse: true });
