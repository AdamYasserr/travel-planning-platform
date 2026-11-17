import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { PostStatus } from '../enums/post-status.enum';

export type PostDocument = HydratedDocument<Post>;

@Schema({ timestamps: true })
export class Post {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  authorId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 160 })
  title: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 20000 })
  body: string;

  @Prop({
    type: [String],
    default: [],
    validate: (tags: string[]) => Array.isArray(tags) && tags.length <= 10,
  })
  tags: string[];

  @Prop({ type: [MongooseSchema.Types.ObjectId], ref: 'Media', default: [] })
  mediaIds: Types.ObjectId[];

  @Prop({
    type: String,
    enum: Object.values(PostStatus),
    default: PostStatus.DRAFT,
    required: true,
    index: true,
  })
  status: PostStatus;

  @Prop({ type: Date, default: null })
  publishedAt?: Date | null;
}

export const PostSchema = SchemaFactory.createForClass(Post);
PostSchema.index({ status: 1, publishedAt: -1 });
PostSchema.index({ tags: 1, status: 1, publishedAt: -1 });
PostSchema.index({ authorId: 1, status: 1, updatedAt: -1 });
