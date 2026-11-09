import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

export enum BudgetCategory {
  FOOD = 'food',
  ACCOMMODATION = 'accommodation',
  IN_CITY_TRANSPORT = 'in_city_transport',
  ACTIVITIES = 'activities',
}

@Schema()
export class BudgetEntry {
  @Prop({
    type: String,
    enum: Object.values(BudgetCategory),
    required: true,
  })
  category: BudgetCategory;

  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({
    type: String,
    required: true,
    uppercase: true,
    trim: true,
    minlength: 3,
    maxlength: 3,
  })
  currency: string;
}

export const BudgetEntrySchema = SchemaFactory.createForClass(BudgetEntry);