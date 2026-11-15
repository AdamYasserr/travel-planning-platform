import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { NotificationType } from '../enums/notification-type.enum';

export type NotificationDocument = HydratedDocument<Notification>;

@Schema({ timestamps: true })
export class Notification {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  recipientId: Types.ObjectId;

  @Prop({
    type: String,
    enum: Object.values(NotificationType),
    required: true,
  })
  type: NotificationType;

  // Polymorphic reference to the event source. Source types are coordinated
  // with event-producing feature owners rather than restricted here.
  @Prop({ type: String, trim: true, default: null })
  resourceType?: string | null;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    default: null,
    validate: {
      validator: (value: Types.ObjectId | null | undefined) =>
        value == null || Types.ObjectId.isValid(value),
      message: 'resourceId must be a valid MongoDB ObjectId',
    },
  })
  resourceId?: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  readAt?: Date | null;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.pre('validate', function validateResourceReferencePair() {
  const hasResourceType = this.resourceType !== undefined && this.resourceType !== null;
  const hasResourceId =
    this.resourceId !== undefined && this.resourceId !== null;

  if (
    hasResourceType &&
    (typeof this.resourceType !== 'string' ||
      this.resourceType.trim().length === 0)
  ) {
    this.invalidate('resourceType', 'resourceType cannot be blank');
  }

  if (hasResourceType !== hasResourceId) {
    this.invalidate(
      'resourceId',
      'resourceType and resourceId must be provided together',
    );
  }
});

NotificationSchema.index({ recipientId: 1, readAt: 1, createdAt: -1 });
