import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types, Schema as MongooseSchema } from 'mongoose';
import { MediaTargetType } from '../dto/upload-media.dto';

export type MediaDocument = HydratedDocument<Media>;

@Schema({ timestamps: true })
export class Media {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  ownerId: Types.ObjectId;

  @Prop({ type: String, enum: Object.values(MediaTargetType), required: true })
  targetType: MediaTargetType;

  @Prop({ type: MongooseSchema.Types.ObjectId, required: false, default: null })
  targetId?: Types.ObjectId | null;

  @Prop({ required: true })
  originalName: string;

  @Prop({ required: true })
  mimeType: string;

  @Prop({ required: true })
  extension: string;

  @Prop({ required: true, min: 1 })
  size: number;

  @Prop({ required: true, unique: true, select: false })
  storageKey: string;
}

export const MediaSchema = SchemaFactory.createForClass(Media);
MediaSchema.index({ ownerId: 1, targetType: 1, targetId: 1 });
