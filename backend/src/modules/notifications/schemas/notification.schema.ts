import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { NotificationType } from '../enums/notification-type.enum';

export type NotificationDocument = HydratedDocument<Notification>;
@Schema({ timestamps: true })
export class Notification {
  declare createdAt: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  /** GEN-01 event type (older notifications may have none). */
  @Prop({ type: String, enum: Object.values(NotificationType), default: null }) type?: NotificationType | null;
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) title: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 1000 }) message: string;
  /** Ids, statuses and amounts of the event, for clients to link to it. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} }) payload?: Record<string, unknown>;
  @Prop({ type: Boolean, default: false, index: true }) isRead: boolean;
  @Prop({ type: String, default: null }) resourceType?: string | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) resourceId?: Types.ObjectId | null;
}
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, isRead: 1 });
