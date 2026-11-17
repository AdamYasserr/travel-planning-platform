import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Schema as MongooseSchema, Types } from "mongoose";
import { ItineraryActivity, ItineraryActivitySchema } from "./activity.schema";
import { BudgetEntry, BudgetEntrySchema } from "./budget.schema";

@Schema()
export class ItineraryDay {
  @Prop({
    type: Number,
    required: true,
    min: 1,
    validate: Number.isInteger,
  })
  dayNumber: number;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: "City",
    required: true,
  })
  cityId: Types.ObjectId;

  @Prop({ type: String, trim: true, default: "" })
  notes: string;

  @Prop({ type: [ItineraryActivitySchema], default: [] })
  activities: ItineraryActivity[];

  @Prop({ type: [BudgetEntrySchema], default: [] })
  budgets: BudgetEntry[];
}

export const ItineraryDaySchema = SchemaFactory.createForClass(ItineraryDay);
