import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";

export enum BudgetCategory {
  FOOD = "food",
  ACCOMMODATION = "accommodation",
  IN_CITY_TRANSPORT = "in_city_transport",
  ACTIVITIES = "activities",
}

export enum BudgetEntryType {
  PLANNED = "planned",
  ACTUAL = "actual",
}

@Schema()
export class BudgetEntry {
  @Prop({ type: String, trim: true, maxlength: 120, default: "" })
  description: string;

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
    match: /^[A-Z]{3}$/,
  })
  currency: string;

  @Prop({
    type: String,
    enum: Object.values(BudgetEntryType),
    required: true,
    default: BudgetEntryType.PLANNED,
  })
  type: BudgetEntryType;

  @Prop({ type: Date, default: Date.now })
  incurredAt: Date;
}

export const BudgetEntrySchema = SchemaFactory.createForClass(BudgetEntry);
