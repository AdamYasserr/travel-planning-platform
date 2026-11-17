import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { CommentStatus } from '../enums/post-status.enum';

export type CommentDocument = HydratedDocument<Comment>;

@Schema({ timestamps: true })
export class Comment {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'Post',
    required: true,
    index: true,
  })
  postId: Types.ObjectId;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  authorId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 5000 })
  body: string;

  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Media', default: [] })
  mediaIds: Types.ObjectId[];

  @Prop({
    type: String,
    enum: Object.values(CommentStatus),
    default: CommentStatus.VISIBLE,
    required: true,
    index: true,
  })
  status: CommentStatus;
}

export const CommentSchema = SchemaFactory.createForClass(Comment);
CommentSchema.index({ postId: 1, status: 1, createdAt: 1 });
