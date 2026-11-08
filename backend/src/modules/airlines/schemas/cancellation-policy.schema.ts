
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  HydratedDocument,
  Schema as MongooseSchema,
  Types,
} from 'mongoose';

export type CancellationPolicyDocument =
  HydratedDocument<CancellationPolicy>;

// FLT-09: Cancellation refund tier
@Schema({ _id: false })
export class CancellationTier {
  @Prop({
    required: true,
    type: Number,
    min: 0,
    validate: Number.isInteger,
  })
  daysBeforeDeparture: number;

  @Prop({
    required: true,
    type: Number,
    min: 0,
    max: 100,
  })
  refundPercentage: number;
}

export const CancellationTierSchema =
  SchemaFactory.createForClass(CancellationTier);

@Schema({ timestamps: true })
export class CancellationPolicy {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Airline',
    required: true,
    unique: true,
  })
  airlineId: Types.ObjectId;

  @Prop({
    type: [CancellationTierSchema],
    required: true,
    default: [],
    validate: {
      validator: (tiers: CancellationTier[]) => {
        const thresholds = tiers.map(
          (tier) => tier.daysBeforeDeparture,
        );

        return (
          thresholds.length ===
          new Set(thresholds).size
        );
      },
      message:
        'Cancellation tier thresholds must be unique',
    },
  })
  tiers: CancellationTier[];

  @Prop({ type: String, default: '' })
  description: string;
}

export const CancellationPolicySchema =
  SchemaFactory.createForClass(CancellationPolicy);
