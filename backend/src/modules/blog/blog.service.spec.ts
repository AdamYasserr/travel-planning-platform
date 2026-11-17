import { jest } from '@jest/globals';
import { Types } from 'mongoose';
import { BlogService } from './blog.service';
import { CommentStatus, PostStatus } from './enums/post-status.enum';

describe('BlogService', () => {
  const authorId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const postId = new Types.ObjectId().toString();
  const commentId = new Types.ObjectId().toString();
  let service: BlogService;
  let posts: any;
  let comments: any;
  let likes: any;
  let users: any;
  let media: any;
  let audit: any;

  const post = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(postId),
    authorId: new Types.ObjectId(authorId),
    title: 'Trip',
    body: 'Story',
    tags: ['egypt'],
    status: PostStatus.PUBLISHED,
    publishedAt: new Date('2099-01-01T00:00:00Z'),
    mediaIds: [],
    save: jest.fn(async function (this: any) {
      return this;
    }),
    toObject() {
      const { save, toObject, ...plain } = this;
      return plain;
    },
    ...overrides,
  });

  beforeEach(() => {
    posts = {
      create: jest.fn(async (value: any) => post(value)),
      findById: jest.fn(() => ({ exec: async () => post() })),
      findOne: jest.fn(() => ({ exec: async () => post() })),
      find: jest.fn(() => ({
        sort: () => ({
          skip: () => ({ limit: () => ({ exec: async () => [post()] }) }),
        }),
      })),
      countDocuments: jest.fn(() => ({ exec: async () => 1 })),
      updateMany: jest.fn(() => ({ exec: async () => ({ modifiedCount: 1 }) })),
    };
    comments = {
      create: jest.fn(async (value: any) => ({
        ...value,
        _id: new Types.ObjectId(commentId),
        toObject() {
          return this;
        },
      })),
      findById: jest.fn(() => ({
        exec: async () => ({
          _id: new Types.ObjectId(commentId),
          postId: new Types.ObjectId(postId),
          authorId: new Types.ObjectId(authorId),
          body: 'Nice',
          status: CommentStatus.VISIBLE,
          save: jest.fn(async function (this: any) {
            return this;
          }),
          toObject() {
            return this;
          },
        }),
      })),
      find: jest.fn(() => ({
        select: () => ({ exec: async () => [] }),
        sort: () => ({
          skip: () => ({ limit: () => ({ exec: async () => [] }) }),
        }),
      })),
      countDocuments: jest.fn(() => ({ exec: async () => 0 })),
      deleteMany: jest.fn(() => ({ exec: async () => ({ deletedCount: 0 }) })),
      updateMany: jest.fn(() => ({ exec: async () => ({ modifiedCount: 0 }) })),
    };
    likes = {
      create: jest.fn(async () => ({})),
      countDocuments: jest.fn(() => ({ exec: async () => 3 })),
      exists: jest.fn(async () => null),
      deleteOne: jest.fn(() => ({ exec: async () => ({ deletedCount: 1 }) })),
      deleteMany: jest.fn(() => ({ exec: async () => ({ deletedCount: 0 }) })),
    };
    users = {
      findById: jest.fn(() => ({
        select: () => ({
          exec: async () => ({
            _id: new Types.ObjectId(authorId),
            name: 'Traveler',
          }),
        }),
      })),
      findOne: jest.fn(() => ({
        select: () => ({
          exec: async () => ({
            _id: new Types.ObjectId(authorId),
            name: 'Traveler',
          }),
        }),
      })),
    };
    media = {
      listTargetMedia: jest.fn(async () => []),
      deleteTargetMedia: jest.fn(async () => undefined),
    };
    audit = { record: jest.fn(async () => undefined) };
    service = new BlogService(
      posts as never,
      comments as never,
      likes as never,
      users as never,
      media as never,
      audit as never,
    );
  });

  it('creates drafts by default, associates the author, and normalizes tags', async () => {
    await service.createPost(authorId, {
      title: 'Trip',
      body: 'Story',
      tags: ['Egypt', ' Nile '],
    } as any);
    expect(posts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        authorId: new Types.ObjectId(authorId),
        title: 'Trip',
        status: PostStatus.DRAFT,
        tags: ['egypt', 'nile'],
        publishedAt: null,
      }),
    );
  });

  it('only exposes published posts to public visitors', async () => {
    posts.findById.mockImplementation(() => ({
      exec: async () =>
        post({
          status: PostStatus.DRAFT,
          authorId: new Types.ObjectId(authorId),
        }),
    }));
    await expect(service.getPost(postId, otherUserId)).rejects.toThrow(
      'Post not found',
    );
  });

  it('scopes updates to the author and rejects non-owner access', async () => {
    posts.findOne.mockImplementation(() => ({ exec: async () => null }));
    await expect(
      service.updatePost(otherUserId, postId, { title: 'Changed' } as any),
    ).rejects.toThrow('Post not found');
  });

  it('allows the author to edit their own published post', async () => {
    const owned = post();
    posts.findOne.mockImplementation(() => ({ exec: async () => owned }));
    await service.updatePost(authorId, postId, { title: 'Updated' } as any);
    expect(owned.title).toBe('Updated');
    expect(owned.save).toHaveBeenCalled();
  });

  it('soft-deletes author posts, their comments, likes, and linked media', async () => {
    const owned = post();
    posts.findOne.mockImplementation(() => ({ exec: async () => owned }));
    await service.deletePost(authorId, postId);
    expect(owned.status).toBe(PostStatus.DELETED);
    expect(media.deleteTargetMedia).toHaveBeenCalledWith(authorId, 'post', postId, true);
    expect(comments.updateMany).toHaveBeenCalled();
    expect(likes.deleteMany).toHaveBeenCalled();
  });

  it('rejects a second like and reports the current count', async () => {
    await expect(service.likePost(authorId, postId)).resolves.toEqual({
      postId,
      liked: true,
      likes: 3,
    });
    likes.create.mockRejectedValue({ code: 11000 } as never);
    await expect(service.likePost(authorId, postId)).rejects.toThrow(
      'already liked',
    );
  });

  it('allows comments only on published posts and returns visible comments', async () => {
    await service.addComment(authorId, postId, { body: 'Nice' } as any);
    expect(comments.create).toHaveBeenCalledWith(
      expect.objectContaining({
        postId: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(authorId),
        status: CommentStatus.VISIBLE,
      }),
    );
    posts.findById.mockImplementation(() => ({
      exec: async () => post({ status: PostStatus.HIDDEN }),
    }));
    await expect(
      service.addComment(authorId, postId, { body: 'No longer public' } as any),
    ).rejects.toThrow('Post not found');
  });

  it('audits administrator hide actions and removes public visibility', async () => {
    const hiddenPost = post();
    posts.findById.mockImplementation(() => ({ exec: async () => hiddenPost }));
    await service.moderatePost(postId, 'hide', otherUserId);
    expect(hiddenPost.status).toBe(PostStatus.HIDDEN);
    expect(audit.record).toHaveBeenCalledWith(
      otherUserId,
      'community.post.hidden',
      'post',
      postId,
      {},
    );
  });

  it('rejects invalid tags instead of building an unsafe search expression', async () => {
    await expect(
      service.listPostsByTag('bad tag', {
        page: 1,
        limit: 20,
        sort: 'newest',
      } as any),
    ).rejects.toThrow('Invalid tag');
  });
});
