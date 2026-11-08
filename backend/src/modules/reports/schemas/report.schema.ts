import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';
import { ReportTargetType } from '../dto/create-report.dto';

export type ReportDocument = HydratedDocument<Report>;

export enum ReportStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
}

@Schema({ timestamps: true })
export class Report {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  reporterId: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(ReportTargetType),
    required: true,
  })
  targetType: ReportTargetType;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    required: true,
  })
  targetId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true })
  reason: string;

  @Prop({
    type: String,
    enum: Object.values(ReportStatus),
    default: ReportStatus.OPEN,
  })
  status: ReportStatus;
}

export const ReportSchema = SchemaFactory.createForClass(Report);

ReportSchema.index(
  { reporterId: 1, targetType: 1, targetId: 1 },
  { unique: true },
);
