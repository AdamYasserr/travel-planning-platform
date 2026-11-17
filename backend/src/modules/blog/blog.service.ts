import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';

import { User, UserDocument } from '../../users/user.schema';
import { ItinerariesService } from '../itineraries/itineraries.service';
import { MediaService } from '../media/media.service';
import {
  CreateCommentDto,
  CreatePostDto,
  PostsQueryDto,
  SearchPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { PostStatus } from './enums/post-status.enum';
import { Comment, CommentDocument } from './schemas/comment.schema';
import { Post, PostDocument } from './schemas/post.schema';
import { PostLike, PostLikeDocument } from './schemas/post-like.schema';

const PAGE_SIZE = 10;

interface AggregatedPost {
  _id: Types.ObjectId;
  title: string;
  body?: string;
  tags?: string[];
  imageIds?: Types.ObjectId[];
  status?: PostStatus;
  createdAt: Date;
  author: { _id: Types.ObjectId; name: string }[];
  likeCount: number;
  commentCount: number;
  interactionScore?: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class BlogService {
  constructor(
    @InjectModel(Post.name)
    private readonly postModel: Model<PostDocument>,
    @InjectModel(Comment.name)
    private readonly commentModel: Model<CommentDocument>,
    @InjectModel(PostLike.name)
    private readonly postLikeModel: Model<PostLikeDocument>,
    @InjectModel(User.name)
    private readonly userModel: Model<UserDocument>,
    private readonly mediaService: MediaService,
    private readonly itinerariesService: ItinerariesService,
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

  async listPublishedPosts(query: PostsQueryDto) {
    const filter: Record<string, unknown> = {
      status: PostStatus.PUBLISHED,
      isHidden: false,
    };
    if (query.tag) filter.tags = query.tag;

    return this.getPostPage(filter, query.page ?? 1, false);
  }

  async getPublishedPost(postId: string) {
    const postObjectId = this.toObjectId(postId, 'post');
    const post = await this.postModel
      .findOne({
        _id: postObjectId,
        status: PostStatus.PUBLISHED,
        isHidden: false,
      })
      .populate({ path: 'authorId', select: 'name' })
      .lean()
      .exec();

    if (!post) {
      throw new NotFoundException('Post not found');
    }

    const [comments, likeCount] = await Promise.all([
      this.commentModel
        .find({ postId: postObjectId, isHidden: false })
        .sort({ createdAt: 1, _id: 1 })
        .populate({ path: 'authorId', select: 'name' })
        .lean()
        .exec(),
      this.postLikeModel.countDocuments({ postId: postObjectId }).exec(),
    ]);

    const populatedPost = post as unknown as Record<string, any>;
    return {
      id: postObjectId.toString(),
      title: populatedPost.title,
      author: this.toPublicAuthor(populatedPost.authorId),
      createdAt: populatedPost.createdAt,
      body: populatedPost.body,
      tags: populatedPost.tags ?? [],
      images: (populatedPost.imageIds ?? []).map((id: Types.ObjectId) => ({
        id: id.toString(),
        url: `/api/media/public/${id.toString()}/content`,
      })),
      likeCount,
      comments: comments.map((comment) => {
        const item = comment as unknown as Record<string, any>;
        return {
          id: item._id.toString(),
          author: this.toPublicAuthor(item.authorId),
          createdAt: item.createdAt,
          body: item.body,
        };
      }),
    };
  }

  async listMyPosts(authorId: string, query: PostsQueryDto) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    return this.getPostPage(
      { authorId: authorObjectId },
      query.page ?? 1,
      true,
    );
  }

  async getAuthorPage(authorId: string, query: PostsQueryDto) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const author = await this.userModel
      .findOne({
        _id: authorObjectId,
        isActive: true,
        isSuspended: false,
        deactivatedAt: null,
      })
      .select('_id name createdAt')
      .lean()
      .exec();

    if (!author) {
      throw new NotFoundException('Author not found');
    }

    const authorWithTimestamps = author as typeof author & {
      createdAt: Date;
    };

    const [posts, itineraries] = await Promise.all([
      this.getPostPage(
        {
          authorId: authorObjectId,
          status: PostStatus.PUBLISHED,
          isHidden: false,
        },
        query.page ?? 1,
        false,
      ),
      this.itinerariesService.findPublicByOwnerId(authorObjectId.toString()),
    ]);

    return {
      author: {
        id: author._id.toString(),
        name: author.name,
        joinedAt: authorWithTimestamps.createdAt,
      },
      posts,
      publicItineraries: itineraries,
    };
  }

  async searchPublishedPosts(query: SearchPostsQueryDto) {
    const page = query.page ?? 1;
    const keyword = new RegExp(escapeRegex(query.keyword), 'i');
    const matchingAuthors = await this.userModel
      .find({ name: keyword })
      .select('_id')
      .lean()
      .exec();

    const branches: Record<string, unknown>[] = [
      { title: keyword },
      { tags: keyword },
    ];
    if (matchingAuthors.length > 0) {
      branches.push({
        authorId: { $in: matchingAuthors.map((user) => user._id) },
      });
    }

    const pipeline: PipelineStage[] = [
      {
        $match: {
          status: PostStatus.PUBLISHED,
          isHidden: false,
          $or: branches,
        },
      },
      ...this.interactionCountStages(),
      { $addFields: { interactionScore: { $add: ['$likeCount', '$commentCount'] } } },
      { $sort: { interactionScore: -1, createdAt: -1, _id: -1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * PAGE_SIZE },
            { $limit: PAGE_SIZE },
            ...this.authorLookupStages(),
          ],
          metadata: [{ $count: 'totalItems' }],
        },
      },
    ];

    const [result] = await this.postModel.aggregate(pipeline).exec();
    const totalItems = result?.metadata?.[0]?.totalItems ?? 0;
    return {
      items: (result?.items ?? []).map((post: AggregatedPost) => ({
        ...this.toPostSummary(post, false),
        excerpt: (post.body ?? '').slice(0, 200),
        interactionScore: post.interactionScore ?? 0,
      })),
      pagination: this.pagination(page, totalItems),
    };
  }

  async updatePost(authorId: string, postId: string, dto: UpdatePostDto) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const updates: Record<string, unknown> = {};
    for (const field of ['title', 'body', 'status', 'tags'] as const) {
      if (dto[field] !== undefined) updates[field] = dto[field];
    }

    if (Object.keys(updates).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    const post = await this.postModel
      .findOneAndUpdate(
        { _id: postObjectId, authorId: authorObjectId },
        { $set: updates },
        { new: true, runValidators: true },
      )
      .exec();

    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  async deletePost(authorId: string, postId: string) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const session = await this.postModel.db.startSession();

    let cleanupPostMedia: (() => Promise<number>) | undefined;
    try {
      await session.withTransaction(async () => {
        const post = await this.postModel
          .findOne({ _id: postObjectId, authorId: authorObjectId })
          .select('imageIds')
          .session(session)
          .exec();

        if (!post) {
          throw new NotFoundException('Post not found');
        }

        cleanupPostMedia = await this.mediaService.preparePostMediaDeletion(
          authorId,
          postObjectId.toString(),
          session,
        );

        await this.commentModel
          .deleteMany({ postId: postObjectId })
          .session(session)
          .exec();
        await this.postLikeModel
          .deleteMany({ postId: postObjectId })
          .session(session)
          .exec();

        const deletion = await this.postModel
          .deleteOne({ _id: postObjectId, authorId: authorObjectId })
          .session(session)
          .exec();
        if (deletion.deletedCount !== 1) {
          throw new NotFoundException('Post not found');
        }
      });
    } finally {
      await session.endSession();
    }

    const pendingMediaFiles = (await cleanupPostMedia?.()) ?? 0;

    return {
      message: pendingMediaFiles
        ? 'Post deleted; storage cleanup queued for retry'
        : 'Post deleted successfully',
      storageCleanupPending: pendingMediaFiles > 0,
      pendingMediaFiles,
    };
  }

  async likePost(userId: string, postId: string) {
    const userObjectId = this.toObjectId(userId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    await this.requirePublishedPost(postObjectId);

    try {
      await this.postLikeModel
        .updateOne(
          { postId: postObjectId, userId: userObjectId },
          { $setOnInsert: { postId: postObjectId, userId: userObjectId } },
          { upsert: true },
        )
        .exec();
    } catch (error: unknown) {
      if (!this.isDuplicateKeyError(error)) throw error;
    }

    return {
      postId: postObjectId.toString(),
      liked: true,
      likeCount: await this.postLikeModel
        .countDocuments({ postId: postObjectId })
        .exec(),
    };
  }

  async unlikePost(userId: string, postId: string) {
    const userObjectId = this.toObjectId(userId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    await this.requirePublishedPost(postObjectId);

    await this.postLikeModel
      .deleteOne({ postId: postObjectId, userId: userObjectId })
      .exec();

    return {
      postId: postObjectId.toString(),
      liked: false,
      likeCount: await this.postLikeModel
        .countDocuments({ postId: postObjectId })
        .exec(),
    };
  }

  async createComment(
    authorId: string,
    postId: string,
    dto: CreateCommentDto,
  ) {
    const authorObjectId = this.toObjectId(authorId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    await this.requirePublishedPost(postObjectId);

    return this.commentModel.create({
      postId: postObjectId,
      authorId: authorObjectId,
      body: dto.body,
    });
  }

  async updateComment(
    userId: string,
    postId: string,
    commentId: string,
    dto: UpdateCommentDto,
  ) {
    const userObjectId = this.toObjectId(userId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const commentObjectId = this.toObjectId(commentId, 'comment');
    if (dto.body === undefined) {
      throw new BadRequestException('Comment body is required');
    }
    await this.requirePublishedPost(postObjectId);

    const comment = await this.commentModel
      .findOneAndUpdate(
        {
          _id: commentObjectId,
          postId: postObjectId,
          authorId: userObjectId,
          isHidden: false,
        },
        { $set: { body: dto.body } },
        { new: true, runValidators: true },
      )
      .exec();

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    return comment;
  }

  async deleteComment(userId: string, postId: string, commentId: string) {
    const userObjectId = this.toObjectId(userId, 'user');
    const postObjectId = this.toObjectId(postId, 'post');
    const commentObjectId = this.toObjectId(commentId, 'comment');
    await this.requirePublishedPost(postObjectId);

    const comment = await this.commentModel
      .findOneAndDelete({
        _id: commentObjectId,
        postId: postObjectId,
        authorId: userObjectId,
        isHidden: false,
      })
      .exec();

    if (!comment) {
      throw new NotFoundException('Comment not found');
    }
    return { message: 'Comment deleted successfully' };
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

  private async getPostPage(
    filter: Record<string, unknown>,
    page: number,
    includeStatus: boolean,
  ) {
    const [result] = await this.postModel
      .aggregate([
        { $match: filter },
        ...this.interactionCountStages(),
        { $sort: { createdAt: -1, _id: -1 } },
        {
          $facet: {
            items: [
              { $skip: (page - 1) * PAGE_SIZE },
              { $limit: PAGE_SIZE },
              ...this.authorLookupStages(),
            ],
            metadata: [{ $count: 'totalItems' }],
          },
        },
      ])
      .exec();

    const totalItems = result?.metadata?.[0]?.totalItems ?? 0;
    return {
      items: (result?.items ?? []).map((post: AggregatedPost) =>
        this.toPostSummary(post, includeStatus),
      ),
      pagination: this.pagination(page, totalItems),
    };
  }

  private interactionCountStages() {
    return [
      {
        $lookup: {
          from: this.postLikeModel.collection.name,
          let: { postId: '$_id' },
          pipeline: [
            { $match: { $expr: { $eq: ['$postId', '$$postId'] } } },
            { $count: 'count' },
          ],
          as: 'likeCounts',
        },
      },
      {
        $lookup: {
          from: this.commentModel.collection.name,
          let: { postId: '$_id' },
          pipeline: [
            {
              $match: {
                isHidden: false,
                $expr: { $eq: ['$postId', '$$postId'] },
              },
            },
            { $count: 'count' },
          ],
          as: 'commentCounts',
        },
      },
      {
        $addFields: {
          likeCount: {
            $ifNull: [{ $arrayElemAt: ['$likeCounts.count', 0] }, 0],
          },
          commentCount: {
            $ifNull: [{ $arrayElemAt: ['$commentCounts.count', 0] }, 0],
          },
        },
      },
    ];
  }

  private authorLookupStages() {
    return [
      {
        $lookup: {
          from: this.userModel.collection.name,
          let: { authorId: '$authorId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$authorId'] } } },
            { $project: { _id: 1, name: 1 } },
          ],
          as: 'author',
        },
      },
    ];
  }

  private toPostSummary(post: AggregatedPost, includeStatus: boolean) {
    const author = post.author?.[0];
    return {
      id: post._id.toString(),
      title: post.title,
      author: author ? { id: author._id.toString(), name: author.name } : null,
      createdAt: post.createdAt,
      ...(includeStatus ? { status: post.status } : {}),
      likeCount: post.likeCount ?? 0,
      commentCount: post.commentCount ?? 0,
    };
  }

  private pagination(page: number, totalItems: number) {
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);
    return {
      page,
      pageSize: PAGE_SIZE,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1 && totalPages > 0,
    };
  }

  private toPublicAuthor(author: unknown) {
    if (!author || typeof author !== 'object') return null;
    const value = author as { _id?: Types.ObjectId; name?: string };
    if (!value._id) return null;
    return { id: value._id.toString(), name: value.name };
  }

  private async requirePublishedPost(postId: Types.ObjectId) {
    const post = await this.postModel
      .findOne({
        _id: postId,
        status: PostStatus.PUBLISHED,
        isHidden: false,
      })
      .select('_id')
      .exec();

    if (!post) {
      throw new NotFoundException('Published post not found');
    }
    return post;
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }

  private toObjectId(value: string, label: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label} ID`);
    }

    return new Types.ObjectId(value);
  }
}
