import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class AuditLog {
  @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
  actorId: Types.ObjectId;

  @Prop({ type: String, required: true, index: true })
  action: string;

  @Prop({ type: String, required: true })
  targetType: string;

  @Prop({ type: String, default: null })
  targetId?: string | null;

  @Prop({ type: Object, default: {} })
  details: Record<string, unknown>;

  createdAt?: Date;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);