import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
export type NotificationDocument = HydratedDocument<Notification>;
@Schema({ timestamps: true })
export class Notification {
  declare createdAt: Date;
  @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true, index: true }) userId: Types.ObjectId;
  @Prop({ type: String, required: true, trim: true, maxlength: 120 }) title: string;
  @Prop({ type: String, required: true, trim: true, maxlength: 1000 }) message: string;
  @Prop({ type: Boolean, default: false, index: true }) isRead: boolean;
  @Prop({ type: String, default: null }) resourceType?: string | null;
  @Prop({ type: MongooseSchema.Types.ObjectId, default: null }) resourceId?: Types.ObjectId | null;
}
export const NotificationSchema = SchemaFactory.createForClass(Notification);
NotificationSchema.index({ userId: 1, createdAt: -1 });
