import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
export type CountryDocument = HydratedDocument<Country>;
@Schema({ timestamps: true })
export class Country {
  @Prop({ type: String, required: true, trim: true }) name: string;
  @Prop({ type: String, required: true, trim: true, index: true }) sourceId: string;
  @Prop({ type: String, trim: true, uppercase: true, match: /^[A-Z]{3}$/ }) currencyCode?: string;
}
export const CountrySchema = SchemaFactory.createForClass(Country);
CountrySchema.index({ sourceId: 1 }, { unique: true });
