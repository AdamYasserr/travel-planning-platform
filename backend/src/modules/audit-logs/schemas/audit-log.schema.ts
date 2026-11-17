import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ timestamps: true })
export class AuditLog {
  declare createdAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  actorId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    trim: true,
    maxlength: 100,
    index: true,
  })
  action: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 40 })
  targetType: string;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: true, index: true })
  targetId: Types.ObjectId;

  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  details: Record<string, unknown>;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
AuditLogSchema.index({ createdAt: -1 });
