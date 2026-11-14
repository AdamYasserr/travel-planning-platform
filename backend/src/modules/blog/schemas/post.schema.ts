import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

import { PostStatus } from '../enums/post-status.enum';

export type PostDocument = HydratedDocument<Post>;

function trimTagValues(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((tag: unknown) =>
        typeof tag === 'string' ? tag.trim() : tag,
      )
    : value;
}

function tagsAreValid(tags: string[]): boolean {
  return (
    Array.isArray(tags) &&
    tags.length <= 5 &&
    tags.every(
      (tag) =>
        typeof tag === 'string' &&
        tag.trim().length > 0 &&
        tag.trim().length <= 30,
    )
  );
}

function isNonBlankString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function imageIdsAreWithinLimit(imageIds: Types.ObjectId[]): boolean {
  return Array.isArray(imageIds) && imageIds.length <= 5;
}

@Schema({ timestamps: true })
export class Post {
  declare createdAt: Date;
  declare updatedAt: Date;

  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
  })
  authorId: Types.ObjectId;

  @Prop({
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isNonBlankString,
      message: 'Title cannot be empty',
    },
  })
  title: string;

  @Prop({
    type: String,
    required: true,
    trim: true,
    validate: {
      validator: isNonBlankString,
      message: 'Body cannot be empty',
    },
  })
  body: string;

  @Prop({
    type: String,
    enum: Object.values(PostStatus),
    required: true,
  })
  status: PostStatus;

  @Prop({
    type: [String],
    default: [],
    set: trimTagValues,
    validate: {
      validator: tagsAreValid,
      message:
        'A post can have at most 5 non-empty tags, each at most 30 characters',
    },
  })
  tags: string[];

  @Prop({
    type: [MongooseSchema.Types.ObjectId],
    ref: 'Media',
    default: [],
    validate: {
      validator: imageIdsAreWithinLimit,
      message: 'A post can have at most 5 images',
    },
  })
  imageIds: Types.ObjectId[];

  @Prop({ type: Boolean, default: false, required: true })
  isHidden: boolean;
}

export const PostSchema = SchemaFactory.createForClass(Post);

PostSchema.index({ status: 1, isHidden: 1, createdAt: -1, _id: -1 });
PostSchema.index({ authorId: 1, status: 1, createdAt: -1, _id: -1 });
PostSchema.index({
  status: 1,
  isHidden: 1,
  tags: 1,
  createdAt: -1,
  _id: -1,
});
PostSchema.index({ title: 'text', tags: 'text' });
