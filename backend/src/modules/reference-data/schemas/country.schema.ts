import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CountryDocument = HydratedDocument<Country>;

/** Dataset: Countries.csv (code, name, currency). `code` is the public identifier. */
@Schema()
export class Country {
  @Prop({ type: String, required: true, trim: true, uppercase: true })
  code: string;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/ })
  currency: string;
}

export const CountrySchema = SchemaFactory.createForClass(Country);
CountrySchema.index({ code: 1 }, { unique: true });
CountrySchema.index({ currency: 1 });
