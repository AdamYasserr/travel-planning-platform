import { jest } from '@jest/globals';
import { Connection, Model, createConnection } from 'mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { MediaService } from '../media/media.service';
import { Media, MediaSchema } from '../media/schemas/media.schema';
import { PostStatus } from './enums/post-status.enum';
import { BlogService } from './blog.service';
import { Comment, CommentSchema } from './schemas/comment.schema';
import { Post, PostSchema } from './schemas/post.schema';
import { PostLike, PostLikeSchema } from './schemas/post-like.schema';

const mongoUri = process.env.MONGODB_TEST_URI;
const describeWithMongo = mongoUri ? describe : describe.skip;

function failAfterExec(model: Record<string, any>, method: string) {
  const original = model[method].bind(model);
  model[method] = (...args: any[]) => {
    const query = original(...args);
    const exec = query.exec.bind(query);
    query.exec = async () => {
      await exec();
      throw new Error('Injected failure to exercise transaction rollback');
    };
    return query;
  };
  return () => {
    model[method] = original;
  };
}

describeWithMongo('Phase 2 MongoDB integration', () => {
  let connection: Connection;
  let postModel: Model<any>;
  let commentModel: Model<any>;
  let likeModel: Model<any>;
  let mediaModel: Model<any>;
  let blogService: BlogService;
  let mediaService: MediaService;
  let storage: {
    remove: jest.Mock;
    retryPendingRemovals: jest.Mock;
  };

  const authorId = '507f1f77bcf86cd799439011';
  const readerId = '507f1f77bcf86cd799439012';

  beforeAll(async () => {
    if (mongoUri === process.env.MONGODB_URI) {
      throw new Error(
        'MONGODB_TEST_URI must be separate from the application MONGODB_URI',
      );
    }

    connection = await createConnection(mongoUri!, {
      dbName: `blog_phase2_integration_${process.pid}_${Date.now()}`,
      serverSelectionTimeoutMS: 5000,
    }).asPromise();

    postModel = connection.model(Post.name, PostSchema);
    commentModel = connection.model(Comment.name, CommentSchema);
    likeModel = connection.model(PostLike.name, PostLikeSchema);
    mediaModel = connection.model(Media.name, MediaSchema);
    const userModel = connection.model(User.name, UserSchema);
    const itineraryModel = {} as never;

    await Promise.all([
      postModel.init(),
      commentModel.init(),
      likeModel.init(),
      mediaModel.init(),
      userModel.init(),
    ]);

    storage = {
      remove: jest.fn(async () => ({ status: 'removed' as const })),
      retryPendingRemovals: jest.fn(async () => ({ completed: 0, pending: 0 })),
    };
    mediaService = new MediaService(
      mediaModel as never,
      userModel as never,
      itineraryModel as never,
      postModel as never,
      storage as never,
    );
    blogService = new BlogService(
      postModel as never,
      commentModel as never,
      likeModel as never,
      userModel as never,
      mediaService,
      { findPublicByOwnerId: jest.fn(async () => []) } as never,
    );
  });

  afterEach(async () => {
    await Promise.all([
      postModel?.deleteMany({}),
      commentModel?.deleteMany({}),
      likeModel?.deleteMany({}),
      mediaModel?.deleteMany({}),
    ]);
    storage?.remove.mockClear();
  });

  afterAll(async () => {
    if (connection?.readyState === 1) {
      await connection.dropDatabase();
      await connection.close();
    }
  });

  async function createPublishedPost(imageIds: unknown[] = []) {
    return postModel.create({
      authorId,
      title: 'Integration post',
      body: 'Body',
      status: PostStatus.PUBLISHED,
      imageIds,
    });
  }

  async function createPostImage(postId: unknown) {
    return mediaModel.create({
      ownerId: authorId,
      targetType: 'post',
      targetId: postId,
      originalName: 'photo.jpg',
      mimeType: 'image/jpeg',
      extension: '.jpg',
      size: 100,
      storageKey: `integration-${Date.now()}-${Math.random()}.jpg`,
    });
  }

  it('prevents duplicate likes under concurrent requests and enforces the unique index', async () => {
    const post = await createPublishedPost();

    await Promise.all(
      Array.from({ length: 16 }, () =>
        blogService.likePost(readerId, post._id.toString()),
      ),
    );
    await expect(
      likeModel.countDocuments({ postId: post._id, userId: readerId }),
    ).resolves.toBe(1);
    await expect(
      likeModel.create({ postId: post._id, userId: readerId }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('rolls back post, comment, like and media changes if post deletion fails', async () => {
    const image = await createPostImage(null);
    const post = await createPublishedPost([image._id]);
    await mediaModel.updateOne({ _id: image._id }, { $set: { targetId: post._id } });
    await commentModel.create({ postId: post._id, authorId: readerId, body: 'Hi' });
    await likeModel.create({ postId: post._id, userId: readerId });
    const restoreDelete = failAfterExec(postModel, 'deleteOne');

    try {
      await expect(
        blogService.deletePost(authorId, post._id.toString()),
      ).rejects.toThrow('Injected failure');
    } finally {
      restoreDelete();
    }

    await expect(postModel.exists({ _id: post._id })).resolves.not.toBeNull();
    await expect(commentModel.countDocuments({ postId: post._id })).resolves.toBe(1);
    await expect(likeModel.countDocuments({ postId: post._id })).resolves.toBe(1);
    await expect(mediaModel.exists({ _id: image._id, cleanupPending: false })).resolves.not.toBeNull();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('rolls back image detachment and cleanup metadata if image removal fails', async () => {
    const image = await createPostImage(null);
    const post = await createPublishedPost([image._id]);
    await mediaModel.updateOne({ _id: image._id }, { $set: { targetId: post._id } });
    const restoreUpdate = failAfterExec(mediaModel, 'updateOne');

    try {
      await expect(
        mediaService.deletePostImage(
          authorId,
          post._id.toString(),
          image._id.toString(),
        ),
      ).rejects.toThrow('Injected failure');
    } finally {
      restoreUpdate();
    }

    const persistedPost = await postModel.findById(post._id).lean();
    expect(persistedPost.imageIds.map((id: { toString(): string }) => id.toString())).toContain(
      image._id.toString(),
    );
    await expect(mediaModel.exists({ _id: image._id, cleanupPending: false })).resolves.not.toBeNull();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('keeps post and media references consistent after image removal', async () => {
    const image = await createPostImage(null);
    const post = await createPublishedPost([image._id]);
    await mediaModel.updateOne({ _id: image._id }, { $set: { targetId: post._id } });

    await mediaService.deletePostImage(
      authorId,
      post._id.toString(),
      image._id.toString(),
    );

    const persistedPost = await postModel.findById(post._id).lean();
    expect(persistedPost.imageIds).toHaveLength(0);
    await expect(mediaModel.exists({ _id: image._id })).resolves.toBeNull();
    expect(storage.remove).toHaveBeenCalledTimes(1);
  });
});
