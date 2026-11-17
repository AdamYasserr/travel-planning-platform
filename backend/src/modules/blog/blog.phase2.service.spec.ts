import { jest } from '@jest/globals';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { Types } from 'mongoose';

import {
  PostsQueryDto,
  SearchPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
} from './dto/blog.dto';
import { PostStatus } from './enums/post-status.enum';
import { BlogService } from './blog.service';

function query(result: unknown) {
  const value: Record<string, any> = {};
  for (const method of ['select', 'populate', 'sort', 'skip', 'limit', 'lean', 'session']) {
    value[method] = jest.fn(() => value);
  }
  value.exec = jest.fn().mockResolvedValue(result);
  return value;
}

describe('BlogService Phase 2', () => {
  const userId = '507f1f77bcf86cd799439011';
  const otherUserId = '507f1f77bcf86cd799439013';
  const postId = '507f1f77bcf86cd799439012';
  const commentId = '507f1f77bcf86cd799439014';

  let service: BlogService;
  let postModel: Record<string, any>;
  let commentModel: Record<string, any>;
  let postLikeModel: Record<string, any>;
  let userModel: Record<string, any>;
  let mediaService: Record<string, any>;
  let itinerariesService: Record<string, any>;
  let session: Record<string, any>;

  beforeEach(() => {
    session = {
      withTransaction: jest.fn(async (work: () => Promise<unknown>) => work()),
      endSession: jest.fn(),
    };
    postModel = {
      aggregate: jest.fn(() => query([{ items: [], metadata: [] }])),
      findOne: jest.fn(() => query({ _id: new Types.ObjectId(postId) })),
      findOneAndUpdate: jest.fn(() => query({ _id: new Types.ObjectId(postId) })),
      deleteOne: jest.fn(() => query({ deletedCount: 1 })),
      db: { startSession: jest.fn().mockResolvedValue(session) },
    };
    commentModel = {
      find: jest.fn(() => query([])),
      findOneAndUpdate: jest.fn(() => query({ _id: new Types.ObjectId(commentId) })),
      findOneAndDelete: jest.fn(() => query({ _id: new Types.ObjectId(commentId) })),
      deleteMany: jest.fn(() => query({ deletedCount: 0 })),
      aggregate: jest.fn(() => query([])),
      collection: { name: 'comments' },
    };
    postLikeModel = {
      updateOne: jest.fn(() => query({ upsertedCount: 1 })),
      deleteOne: jest.fn(() => query({ deletedCount: 1 })),
      countDocuments: jest.fn(() => query(1)),
      deleteMany: jest.fn(() => query({ deletedCount: 0 })),
      aggregate: jest.fn(() => query([])),
      collection: { name: 'blog_post_likes' },
    };
    userModel = {
      find: jest.fn(() => query([{ _id: new Types.ObjectId(userId) }])),
      findOne: jest.fn(() =>
        query({
          _id: new Types.ObjectId(userId),
          name: 'Sosa',
          createdAt: new Date('2020-01-01'),
        }),
      ),
      collection: { name: 'users' },
    };
    mediaService = {
      preparePostMediaDeletion: jest.fn().mockResolvedValue(async () => undefined),
    };
    itinerariesService = {
      findPublicByOwnerId: jest.fn().mockResolvedValue([]),
    };

    service = new BlogService(
      postModel as never,
      commentModel as never,
      postLikeModel as never,
      userModel as never,
      mediaService as never,
      itinerariesService as never,
    );
  });

  it('lists only published visible posts, applies the tag filter and paginates', async () => {
    const aggregateQuery = query([
      {
        items: [
          {
            _id: new Types.ObjectId(postId),
            title: 'Coast trip',
            createdAt: new Date('2026-01-01'),
            author: [{ _id: new Types.ObjectId(userId), name: 'Sosa' }],
            likeCount: 4,
            commentCount: 2,
          },
        ],
        metadata: [{ totalItems: 21 }],
      },
    ]);
    postModel.aggregate.mockReturnValue(aggregateQuery);

    const result = await service.listPublishedPosts({
      page: 2,
      tag: 'Egypt',
    } as PostsQueryDto);

    const pipeline = postModel.aggregate.mock.calls[0][0] as Record<string, any>[];
    expect(pipeline[0].$match).toEqual({
      status: PostStatus.PUBLISHED,
      isHidden: false,
      tags: 'Egypt',
    });
    expect(pipeline.at(-1).$facet.items[0]).toEqual({ $skip: 10 });
    expect(result.items[0]).toMatchObject({
      id: postId,
      author: { id: userId, name: 'Sosa' },
      likeCount: 4,
      commentCount: 2,
    });
    expect(result.pagination).toMatchObject({
      page: 2,
      pageSize: 10,
      totalItems: 21,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('returns a public post with its author, like count and chronological visible comments', async () => {
    const createdAt = new Date('2026-02-03');
    const postQuery = query({
      _id: new Types.ObjectId(postId),
      title: 'Coast trip',
      body: 'A story',
      tags: ['Egypt'],
      imageIds: [],
      createdAt,
      authorId: { _id: new Types.ObjectId(userId), name: 'Sosa' },
    });
    const commentQuery = query([
      {
        _id: new Types.ObjectId(commentId),
        body: 'Nice!',
        createdAt,
        authorId: { _id: new Types.ObjectId(otherUserId), name: 'Reader' },
      },
    ]);
    postModel.findOne.mockReturnValue(postQuery);
    commentModel.find.mockReturnValue(commentQuery);

    const result = await service.getPublishedPost(postId);

    expect(postModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(postId),
      status: PostStatus.PUBLISHED,
      isHidden: false,
    });
    expect(commentModel.find).toHaveBeenCalledWith({
      postId: new Types.ObjectId(postId),
      isHidden: false,
    });
    expect(commentQuery.sort).toHaveBeenCalledWith({ createdAt: 1, _id: 1 });
    expect(result).toMatchObject({
      id: postId,
      author: { id: userId, name: 'Sosa' },
      likeCount: 1,
      comments: [{ id: commentId, author: { id: otherUserId, name: 'Reader' } }],
    });
  });

  it('does not expose a draft or hidden post through public details', async () => {
    postModel.findOne.mockReturnValue(query(null));
    await expect(service.getPublishedPost(postId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('lists only the authenticated author’s posts and includes status', async () => {
    postModel.aggregate.mockReturnValue(
      query([
        {
          items: [
            {
              _id: new Types.ObjectId(postId),
              title: 'Draft',
              status: PostStatus.DRAFT,
              createdAt: new Date(),
              author: [{ _id: new Types.ObjectId(userId), name: 'Sosa' }],
              likeCount: 0,
              commentCount: 0,
            },
          ],
          metadata: [{ totalItems: 1 }],
        },
      ]),
    );

    const result = await service.listMyPosts(userId, { page: 1 } as PostsQueryDto);
    const pipeline = postModel.aggregate.mock.calls[0][0] as Record<string, any>[];

    expect(pipeline[0].$match).toEqual({ authorId: new Types.ObjectId(userId) });
    expect(result.items[0]).toMatchObject({ status: PostStatus.DRAFT });
  });

  it('searches title, tags and author names and ranks by interactions then recency', async () => {
    postModel.aggregate.mockReturnValue(
      query([
        {
          items: [
            {
              _id: new Types.ObjectId(postId),
              title: 'Coast',
              body: 'A sunny coast story',
              createdAt: new Date(),
              author: [{ _id: new Types.ObjectId(userId), name: 'Sosa' }],
              likeCount: 3,
              commentCount: 2,
              interactionScore: 5,
            },
          ],
          metadata: [{ totalItems: 1 }],
        },
      ]),
    );

    const result = await service.searchPublishedPosts({
      keyword: 'coast',
      page: 1,
    } as SearchPostsQueryDto);
    const pipeline = postModel.aggregate.mock.calls[0][0] as Record<string, any>[];

    expect(userModel.find).toHaveBeenCalledWith({ name: /coast/i });
    expect(pipeline[0].$match).toMatchObject({
      status: PostStatus.PUBLISHED,
      isHidden: false,
    });
    expect(pipeline[0].$match.$or).toHaveLength(3);
    expect(pipeline.find((stage) => stage.$sort)?.$sort).toEqual({
      interactionScore: -1,
      createdAt: -1,
      _id: -1,
    });
    expect(result.items[0]).toMatchObject({
      excerpt: 'A sunny coast story',
      interactionScore: 5,
    });
  });

  it('returns an empty page for searches with no matches', async () => {
    userModel.find.mockReturnValue(query([]));
    postModel.aggregate.mockReturnValue(query([{ items: [], metadata: [] }]));

    const result = await service.searchPublishedPosts({
      keyword: 'none',
      page: 1,
    } as SearchPostsQueryDto);
    expect(result.items).toEqual([]);
    expect(result.pagination.totalItems).toBe(0);
  });

  it('updates only the owner’s post and validates updated fields', async () => {
    const updateQuery = query({ _id: new Types.ObjectId(postId) });
    postModel.findOneAndUpdate.mockReturnValue(updateQuery);

    await service.updatePost(userId, postId, {
      title: 'Updated',
    } as UpdatePostDto);

    expect(postModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(postId), authorId: new Types.ObjectId(userId) },
      { $set: { title: 'Updated' } },
      { new: true, runValidators: true },
    );
  });

  it('rejects empty post updates and hides non-owner posts', async () => {
    await expect(service.updatePost(userId, postId, {} as UpdatePostDto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    postModel.findOneAndUpdate.mockReturnValue(query(null));
    await expect(
      service.updatePost(userId, postId, { title: 'Updated' } as UpdatePostDto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('deletes a post and its comments and likes in one transaction', async () => {
    postModel.findOne.mockReturnValue(query({ imageIds: [] }));

    await expect(service.deletePost(userId, postId)).resolves.toMatchObject({
      message: 'Post deleted successfully',
    });
    expect(session.withTransaction).toHaveBeenCalledTimes(1);
    expect(mediaService.preparePostMediaDeletion).toHaveBeenCalledWith(
      userId,
      postId,
      session,
    );
    expect(commentModel.deleteMany).toHaveBeenCalledWith({
      postId: new Types.ObjectId(postId),
    });
    expect(postLikeModel.deleteMany).toHaveBeenCalledWith({
      postId: new Types.ObjectId(postId),
    });
    expect(postModel.deleteOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(postId),
      authorId: new Types.ObjectId(userId),
    });
  });

  it('cleans linked media storage only after the post transaction commits', async () => {
    const cleanup = jest.fn(async () => undefined);
    mediaService.preparePostMediaDeletion.mockResolvedValue(cleanup);
    postModel.findOne.mockReturnValue(query({ imageIds: [new Types.ObjectId()] }));

    await service.deletePost(userId, postId);

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('reports when post storage cleanup has been queued for retry', async () => {
    mediaService.preparePostMediaDeletion.mockResolvedValue(
      jest.fn(async () => 2),
    );
    postModel.findOne.mockReturnValue(query({ imageIds: [new Types.ObjectId()] }));

    await expect(service.deletePost(userId, postId)).resolves.toMatchObject({
      message: 'Post deleted; storage cleanup queued for retry',
      storageCleanupPending: true,
      pendingMediaFiles: 2,
    });
  });

  it('returns author details, published posts and public itineraries', async () => {
    postModel.aggregate.mockReturnValue(query([{ items: [], metadata: [] }]));
    itinerariesService.findPublicByOwnerId.mockResolvedValue([
      { title: 'Public trip' },
    ]);

    const result = await service.getAuthorPage(userId, { page: 1 } as PostsQueryDto);

    expect(userModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(userId),
      isActive: true,
      isSuspended: false,
      deactivatedAt: null,
    });
    expect(itinerariesService.findPublicByOwnerId).toHaveBeenCalledWith(userId);
    expect(result).toMatchObject({
      author: { id: userId, name: 'Sosa' },
      posts: { items: [] },
      publicItineraries: [{ title: 'Public trip' }],
    });
  });

  it('creates a like idempotently and reports the persisted like count', async () => {
    const updateQuery = query({ upsertedCount: 1 });
    postLikeModel.updateOne.mockReturnValue(updateQuery);
    postLikeModel.countDocuments.mockReturnValue(query(2));

    await expect(service.likePost(userId, postId)).resolves.toEqual({
      postId,
      liked: true,
      likeCount: 2,
    });
    expect(postLikeModel.updateOne).toHaveBeenCalledWith(
      { postId: new Types.ObjectId(postId), userId: new Types.ObjectId(userId) },
      {
        $setOnInsert: {
          postId: new Types.ObjectId(postId),
          userId: new Types.ObjectId(userId),
        },
      },
      { upsert: true },
    );
  });

  it('treats a concurrent duplicate-key like as an idempotent success', async () => {
    postLikeModel.updateOne.mockReturnValue(
      query(Promise.reject(Object.assign(new Error('duplicate'), { code: 11000 }))),
    );
    postLikeModel.countDocuments.mockReturnValue(query(1));
    await expect(service.likePost(userId, postId)).resolves.toMatchObject({
      liked: true,
      likeCount: 1,
    });
  });

  it('only allows likes on published, visible posts', async () => {
    postModel.findOne.mockReturnValue(query(null));
    await expect(service.likePost(userId, postId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(postLikeModel.updateOne).not.toHaveBeenCalled();
  });

  it('removes only the authenticated user’s like and reports the new count', async () => {
    postLikeModel.countDocuments.mockReturnValue(query(0));
    await expect(service.unlikePost(userId, postId)).resolves.toEqual({
      postId,
      liked: false,
      likeCount: 0,
    });
    expect(postLikeModel.deleteOne).toHaveBeenCalledWith({
      postId: new Types.ObjectId(postId),
      userId: new Types.ObjectId(userId),
    });
  });

  it('edits only the authenticated user’s comment on an eligible post', async () => {
    const updateQuery = query({ _id: new Types.ObjectId(commentId), body: 'Changed' });
    commentModel.findOneAndUpdate.mockReturnValue(updateQuery);

    await service.updateComment(userId, postId, commentId, {
      body: 'Changed',
    } as UpdateCommentDto);
    expect(commentModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(commentId),
        postId: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(userId),
        isHidden: false,
      },
      { $set: { body: 'Changed' } },
      { new: true, runValidators: true },
    );
  });

  it('rejects edits to another user’s comment and missing bodies', async () => {
    commentModel.findOneAndUpdate.mockReturnValue(query(null));
    await expect(
      service.updateComment(userId, postId, commentId, {
        body: 'Changed',
      } as UpdateCommentDto),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateComment(userId, postId, commentId, {} as UpdateCommentDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('deletes only the authenticated user’s comment on an eligible post', async () => {
    await service.deleteComment(userId, postId, commentId);
    expect(commentModel.findOneAndDelete).toHaveBeenCalledWith({
      _id: new Types.ObjectId(commentId),
      postId: new Types.ObjectId(postId),
      authorId: new Types.ObjectId(userId),
      isHidden: false,
    });

    commentModel.findOneAndDelete.mockReturnValue(query(null));
    await expect(
      service.deleteComment(userId, postId, commentId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
