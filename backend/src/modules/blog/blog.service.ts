import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  CreateCommentDto,
  CreatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { PostStatus } from './enums/post-status.enum';
import { Comment, CommentDocument } from './schemas/comment.schema';
import { Post, PostDocument } from './schemas/post.schema';

@Injectable()
export class BlogService {
  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<PostDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
  ) {}

  async createPost(authorId: string, dto: CreatePostDto) {
    const authorObjectId = this.toObjectId(authorId, 'user');

    return this.postModel.create({
      authorId: authorObjectId,
      title: dto.title,
      body: dto.body,
      status: dto.status,
      tags: dto.tags ?? [],
    });
  }

  async createComment(
    authorId: string,
    postId: string,
    dto: CreateCommentDto,
  ) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const publishedPost = await this.postModel
      .findOne({
        _id: postObjectId,
        status: PostStatus.PUBLISHED,
        isHidden: false,
      })
      .select('_id')
      .exec();

    if (!publishedPost) {
      throw new NotFoundException('Published post not found');
    }

    // This status/visibility read and the comment insert are separate writes.
    // A concurrent moderation or status change can occur between them.
    return this.commentModel.create({
      postId: postObjectId,
      authorId: authorObjectId,
      body: dto.body,
    });
  }

  async updatePostTags(
    authorId: string,
    postId: string,
    dto: UpdatePostTagsDto,
  ) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const post = await this.postModel
      .findOneAndUpdate(
        { _id: postObjectId, authorId: authorObjectId },
        { $set: { tags: dto.tags } },
        { new: true, runValidators: true },
      )
      .exec();

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    return post;
  }

  private toObjectId(value: string, label: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label} ID`);
    }

    return new Types.ObjectId(value);
  }
}
