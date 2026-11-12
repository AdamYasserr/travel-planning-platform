import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ timestamps: true })
export class ExchangeRate {
  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    match: /^[A-Z]{3}$/,
  })
  baseCurrency: string;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    match: /^[A-Z]{3}$/,
  })
  targetCurrency: string;

  @Prop({
    type: Number,
    required: true,
    min: Number.MIN_VALUE,
  })
  rate: number;

  @Prop({ type: Date, required: true })
  fetchedAt: Date;
}

export const ExchangeRateSchema =
  SchemaFactory.createForClass(ExchangeRate);

ExchangeRateSchema.index(
  { baseCurrency: 1, targetCurrency: 1 },
  { unique: true },
);