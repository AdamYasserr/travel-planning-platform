import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';

export type HotelDocument = HydratedDocument<Hotel>;

@Schema({ _id: false })
export class CancellationTier {
  @Prop({
    type: Number,
    required: true,
    min: 0,
    validate: {
      validator: (value: number) => Number.isInteger(value),
      message: 'daysBeforeCheckIn must be a whole number',
    },
  })
  daysBeforeCheckIn: number;

  @Prop({ type: Number, required: true, min: 0, max: 100 })
  refundPercentage: number;
}

export const CancellationTierSchema =
  SchemaFactory.createForClass(CancellationTier);

@Schema({ timestamps: true })
export class Hotel {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({ type: String, required: true, trim: true })
  name: string;

  @Prop({ type: String, required: true, trim: true })
  address: string;

  /** Dataset city_id, e.g. "cairo" */
  @Prop({ type: String, required: true, trim: true, index: true })
  cityId: string;

  /** Dataset country code, e.g. "EG" */
  @Prop({ type: String, required: true, trim: true, uppercase: true, index: true })
  countryId: string;

  @Prop({ type: String, default: '', trim: true })
  description: string;

  @Prop({
    type: [String],
    default: [],
    validate: {
      validator: (photos: string[]) => photos.length <= 5,
      message: 'A hotel can have at most 5 photos',
    },
  })
  photos: string[];

  @Prop({ type: Number, required: true, min: 1, max: 5 })
  starClass: number;

  @Prop({ type: [String], default: [] })
  amenities: string[];

  @Prop({
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  })
  checkInTime: string;

  @Prop({
    type: String,
    required: true,
    match: /^([01]\d|2[0-3]):[0-5]\d$/,
  })
  checkOutTime: string;

  @Prop({
    type: [CancellationTierSchema],
    default: [],
    validate: {
      validator: (tiers: CancellationTier[]) => {
        const thresholds = tiers.map((tier) => tier.daysBeforeCheckIn);
        return new Set(thresholds).size === thresholds.length;
      },
      message: 'Cancellation tier day thresholds must be unique',
    },
  })
  cancellationTiers: CancellationTier[];

  @Prop({ type: Boolean, default: true, index: true })
  isActive: boolean;

  /** Stored average of visible review ratings (1-5); null = unrated. Kept up to date by HotelsService.refreshRating. */
  @Prop({ type: Number, default: null, min: 1, max: 5 })
  averageRating: number | null;

  @Prop({ type: Number, default: 0, min: 0 })
  ratingCount: number;
}

export const HotelSchema = SchemaFactory.createForClass(Hotel);

HotelSchema.index({ cityId: 1, countryId: 1, isActive: 1 });
// HTL-11/12 search: the hotels of one city / one country, active, optionally by rating.
HotelSchema.index({ isActive: 1, cityId: 1, averageRating: -1 });
HotelSchema.index({ isActive: 1, countryId: 1, averageRating: -1 });