import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../../users/user.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { MediaService } from '../media/media.service';
import { MediaTargetType } from '../media/dto/upload-media.dto';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import {
  CreateCommentDto,
  CreatePostDto,
  PostListQueryDto,
  UpdatePostDto,
} from './dto/blog.dto';
import { Comment, CommentDocument } from './schemas/comment.schema';
import { Like, LikeDocument } from './schemas/like.schema';
import { Post, PostDocument } from './schemas/post.schema';
import { CommentStatus, PostStatus } from './enums/post-status.enum';

@Injectable()
export class BlogService {
  constructor(
    @InjectModel(Post.name) private readonly posts: Model<PostDocument>,
    @InjectModel(Comment.name)
    private readonly comments: Model<CommentDocument>,
    @InjectModel(Like.name) private readonly likes: Model<LikeDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly media: MediaService,
    private readonly auditLogs: AuditLogsService,
  ) {}

  async createPost(authorId: string, dto: CreatePostDto) {
    const status = dto.status ?? PostStatus.DRAFT;
    const post = await this.posts.create({
      authorId: this.objectId(authorId),
      title: dto.title,
      body: dto.body,
      tags: this.normalizeTags(dto.tags ?? []),
      status,
      publishedAt: status === PostStatus.PUBLISHED ? new Date() : null,
    });
    return this.presentPost(post, authorId);
  }

  async listPosts(query: PostListQueryDto) {
    const filter: Record<string, unknown> = { status: PostStatus.PUBLISHED };
    if (query.authorId) filter.authorId = this.objectId(query.authorId);
    if (query.tag) filter.tags = query.tag.trim().toLowerCase();
    if (query.q?.trim()) {
      const expression = new RegExp(this.escapeRegex(query.q.trim()), 'i');
      filter.$or = [
        { title: expression },
        { body: expression },
        { tags: expression },
      ];
    }
    return this.paginatePosts(filter, query);
  }

  async listMine(authorId: string, query: PostListQueryDto) {
    const filter: Record<string, unknown> = {
      authorId: this.objectId(authorId),
      status: { $ne: PostStatus.DELETED },
    };
    if (query.q?.trim()) {
      const expression = new RegExp(this.escapeRegex(query.q.trim()), 'i');
      filter.$or = [
        { title: expression },
        { body: expression },
        { tags: expression },
      ];
    }
    if (query.tag) filter.tags = query.tag.trim().toLowerCase();
    return this.paginatePosts(filter, query, authorId);
  }

  async getPost(postId: string, viewerId?: string) {
    const post = await this.findPost(postId);
    if (
      post.status !== PostStatus.PUBLISHED &&
      String(post.authorId) !== viewerId
    ) {
      throw new NotFoundException('Post not found');
    }
    return this.presentPost(post, viewerId);
  }

  async updatePost(authorId: string, postId: string, dto: UpdatePostDto) {
    const post = await this.findOwnedPost(authorId, postId);
    if ([PostStatus.HIDDEN, PostStatus.DELETED].includes(post.status)) {
      throw new NotFoundException('Post not found');
    }
    if (dto.title !== undefined) post.title = dto.title;
    if (dto.body !== undefined) post.body = dto.body;
    if (dto.tags !== undefined) post.tags = this.normalizeTags(dto.tags);
    if (dto.status !== undefined) {
      post.status = dto.status;
      post.publishedAt =
        dto.status === PostStatus.PUBLISHED
          ? (post.publishedAt ?? new Date())
          : null;
    }
    await post.save();
    return this.presentPost(post, authorId);
  }

  async deletePost(authorId: string, postId: string) {
    const post = await this.findOwnedPost(authorId, postId);
    await this.removePostContent(post, authorId);
    return { id: postId, deleted: true };
  }

  async addComment(authorId: string, postId: string, dto: CreateCommentDto) {
    const post = await this.findPost(postId);
    if (post.status !== PostStatus.PUBLISHED)
      throw new NotFoundException('Post not found');
    const comment = await this.comments.create({
      postId: post._id,
      authorId: this.objectId(authorId),
      body: dto.body,
      status: CommentStatus.VISIBLE,
    });
    return this.presentComment(comment);
  }

  async listComments(postId: string, page = 1, limit = 20) {
    const post = await this.findPost(postId);
    if (post.status !== PostStatus.PUBLISHED)
      throw new NotFoundException('Post not found');
    const filter = { postId: post._id, status: CommentStatus.VISIBLE };
    const [rows, total] = await Promise.all([
      this.comments
        .find(filter)
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.comments.countDocuments(filter).exec(),
    ]);
    return {
      items: await Promise.all(rows.map((row) => this.presentComment(row))),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    };
  }

  async updateComment(authorId: string, commentId: string, body: string) {
    const comment = await this.findComment(commentId);
    if (String(comment.authorId) !== authorId)
      throw new NotFoundException('Comment not found');
    if (comment.status !== CommentStatus.VISIBLE)
      throw new NotFoundException('Comment not found');
    await this.requirePublishedPost(comment.postId.toString());
    comment.body = body;
    await comment.save();
    return this.presentComment(comment);
  }

  async deleteComment(authorId: string, commentId: string) {
    const comment = await this.findComment(commentId);
    if (String(comment.authorId) !== authorId)
      throw new NotFoundException('Comment not found');
    await this.removeCommentContent(comment, authorId);
    return { id: commentId, deleted: true };
  }

  async likePost(userId: string, postId: string) {
    const post = await this.findPost(postId);
    if (post.status !== PostStatus.PUBLISHED)
      throw new NotFoundException('Post not found');
    try {
      await this.likes.create({
        postId: post._id,
        userId: this.objectId(userId),
      });
    } catch (error: unknown) {
      if (this.isDuplicateKey(error))
        throw new ConflictException('You have already liked this post');
      throw error;
    }
    return {
      postId,
      liked: true,
      likes: await this.likes.countDocuments({ postId: post._id }).exec(),
    };
  }

  async unlikePost(userId: string, postId: string) {
    const post = await this.findPost(postId);
    if (post.status !== PostStatus.PUBLISHED)
      throw new NotFoundException('Post not found');
    await this.likes
      .deleteOne({ postId: post._id, userId: this.objectId(userId) })
      .exec();
    return {
      postId,
      liked: false,
      likes: await this.likes.countDocuments({ postId: post._id }).exec(),
    };
  }

  async listPostsByTag(tag: string, query: PostListQueryDto) {
    const normalized = tag.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,29}$/.test(normalized))
      throw new BadRequestException('Invalid tag');
    return this.paginatePosts(
      { status: PostStatus.PUBLISHED, tags: normalized },
      query,
    );
  }

  async authorPage(authorId: string) {
    const objectId = this.objectId(authorId);
    const user = await this.users
      .findOne({
        _id: objectId,
        isActive: true,
        isSuspended: false,
        deactivatedAt: null,
      })
      .select('_id name')
      .exec();
    if (!user) throw new NotFoundException('Author not found');
    const query = { page: 1, limit: 20, sort: 'newest' } as PostListQueryDto;
    const posts = await this.paginatePosts(
      { authorId: objectId, status: PostStatus.PUBLISHED },
      query,
    );
    return { author: { id: user._id.toString(), name: user.name }, posts };
  }

  async moderatePost(
    postId: string,
    action: 'hide' | 'delete',
    actorId: string,
    reportId?: string,
  ) {
    const post = await this.findPost(postId);
    if (action === 'hide') {
      if (post.status !== PostStatus.DELETED) {
        post.status = PostStatus.HIDDEN;
        await post.save();
      }
      await this.auditLogs.record(
        actorId,
        'community.post.hidden',
        'post',
        postId,
        reportId ? { reportId } : {},
      );
      return { id: postId, status: post.status };
    }
    await this.removePostContent(post, actorId);
    await this.auditLogs.record(
      actorId,
      'community.post.deleted',
      'post',
      postId,
      reportId ? { reportId } : {},
    );
    return { id: postId, status: PostStatus.DELETED };
  }

  async moderateComment(
    commentId: string,
    action: 'hide' | 'delete',
    actorId: string,
    reportId?: string,
  ) {
    const comment = await this.findComment(commentId);
    if (action === 'hide') {
      if (comment.status !== CommentStatus.DELETED) {
        comment.status = CommentStatus.HIDDEN;
        await comment.save();
      }
      await this.auditLogs.record(
        actorId,
        'community.comment.hidden',
        'comment',
        commentId,
        reportId ? { reportId } : {},
      );
      return { id: commentId, status: comment.status };
    }
    await this.removeCommentContent(comment, actorId);
    await this.auditLogs.record(
      actorId,
      'community.comment.deleted',
      'comment',
      commentId,
      reportId ? { reportId } : {},
    );
    return { id: commentId, status: CommentStatus.DELETED };
  }

  private async removePostContent(post: PostDocument, actorId: string) {
    await this.media.deleteTargetMedia(
      actorId,
      MediaTargetType.POST,
      post._id.toString(),
      true,
    );
    post.status = PostStatus.DELETED;
    post.mediaIds = [];
    await post.save();
    await Promise.all([
      this.removeMediaFromPostComments(post._id.toString()),
      this.comments
        .updateMany(
          { postId: post._id, status: { $ne: CommentStatus.DELETED } },
          { $set: { status: CommentStatus.DELETED, mediaIds: [] } },
        )
        .exec(),
      this.likes.deleteMany({ postId: post._id }).exec(),
    ]);
  }

  private async removeCommentContent(
    comment: CommentDocument,
    actorId: string,
  ) {
    await this.media.deleteTargetMedia(
      actorId,
      MediaTargetType.COMMENT,
      comment._id.toString(),
      true,
    );
    comment.status = CommentStatus.DELETED;
    comment.mediaIds = [];
    await comment.save();
  }

  private async removeMediaFromPostComments(postId: string) {
    const comments = await this.comments.find({ postId }).select('_id').exec();
    await Promise.all(
      comments.map((comment) =>
        this.media.deleteTargetMedia(
          '',
          MediaTargetType.COMMENT,
          comment._id.toString(),
          true,
        ),
      ),
    );
  }

  private async paginatePosts(
    filter: Record<string, unknown>,
    query: PostListQueryDto,
    viewerId?: string,
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(50, Math.max(1, Number(query.limit) || 20));
    const direction = query.sort === 'oldest' ? 1 : -1;
    const [rows, total] = await Promise.all([
      this.posts
        .find(filter)
        .sort({ publishedAt: direction, _id: direction })
        .skip((page - 1) * limit)
        .limit(limit)
        .exec(),
      this.posts.countDocuments(filter).exec(),
    ]);
    return {
      items: await Promise.all(
        rows.map((row) => this.presentPost(row, viewerId)),
      ),
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    };
  }

  private async presentPost(post: PostDocument, viewerId?: string) {
    const [author, likes, media] = await Promise.all([
      this.users.findById(post.authorId).select('_id name').exec(),
      this.likes.countDocuments({ postId: post._id }).exec(),
      this.media.listTargetMedia(
        MediaTargetType.POST,
        post._id.toString(),
        post.status === PostStatus.PUBLISHED,
      ),
    ]);
    return {
      ...post.toObject(),
      author: author ? { id: author._id.toString(), name: author.name } : null,
      likes,
      media,
      viewerLiked: viewerId
        ? Boolean(
            await this.likes.exists({
              postId: post._id,
              userId: this.objectId(viewerId),
            }),
          )
        : false,
    };
  }

  private async presentComment(comment: CommentDocument) {
    const [author, media] = await Promise.all([
      this.users.findById(comment.authorId).select('_id name').exec(),
      this.media.listTargetMedia(
        MediaTargetType.COMMENT,
        comment._id.toString(),
        true,
      ),
    ]);
    return {
      ...comment.toObject(),
      author: author ? { id: author._id.toString(), name: author.name } : null,
      media,
    };
  }

  private async findPost(id: string) {
    const post = await this.posts.findById(this.objectId(id)).exec();
    if (!post || post.status === PostStatus.DELETED)
      throw new NotFoundException('Post not found');
    return post;
  }

  private async findOwnedPost(ownerId: string, id: string) {
    const post = await this.posts
      .findOne({ _id: this.objectId(id), authorId: this.objectId(ownerId) })
      .exec();
    if (!post || post.status === PostStatus.DELETED)
      throw new NotFoundException('Post not found');
    return post;
  }

  private async findComment(id: string) {
    const comment = await this.comments.findById(this.objectId(id)).exec();
    if (!comment || comment.status === CommentStatus.DELETED)
      throw new NotFoundException('Comment not found');
    return comment;
  }

  private async requirePublishedPost(id: string) {
    const post = await this.findPost(id);
    if (post.status !== PostStatus.PUBLISHED)
      throw new NotFoundException('Post not found');
    return post;
  }

  private objectId(value: string) {
    if (!Types.ObjectId.isValid(value))
      throw new BadRequestException('Invalid MongoDB ID');
    return new Types.ObjectId(value);
  }

  private normalizeTags(tags: string[]) {
    const normalized = tags
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean);
    if (
      normalized.length > 10 ||
      normalized.some(
        (tag) => tag.length > 30 || !/^[a-z0-9][a-z0-9-]*$/.test(tag),
      )
    ) {
      throw new BadRequestException(
        'Tags must be at most 30 characters and contain lowercase letters, numbers, and hyphens',
      );
    }
    if (new Set(normalized).size !== normalized.length)
      throw new BadRequestException('Duplicate tags are not allowed');
    return normalized;
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private isDuplicateKey(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 11000
    );
  }
}
