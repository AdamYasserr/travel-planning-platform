import { jest } from '@jest/globals';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

import {
  CreateCommentDto,
  CreatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { PostStatus } from './enums/post-status.enum';
import { BlogService } from './blog.service';

describe('BlogService Phase 1', () => {
  const authorId = '507f1f77bcf86cd799439011';
  const postId = '507f1f77bcf86cd799439012';

  let service: BlogService;
  let postModel: {
    create: jest.Mock;
    findOne: jest.Mock;
    findOneAndUpdate: jest.Mock;
  };
  let commentModel: { create: jest.Mock };

  beforeEach(() => {
    postModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    commentModel = { create: jest.fn() };
    service = new BlogService(postModel as never, commentModel as never);
  });

  it.each([PostStatus.DRAFT, PostStatus.PUBLISHED])(
    'creates a %s post using the authenticated author and optional tags',
    async (status) => {
      const dto = {
        title: 'Weekend in Alexandria',
        body: 'A travel story.',
        status,
        tags: ['Egypt'],
      } as CreatePostDto;
      postModel.create.mockResolvedValue({ _id: postId });

      await expect(service.createPost(authorId, dto)).resolves.toMatchObject({
        _id: postId,
      });

      expect(postModel.create).toHaveBeenCalledWith({
        authorId: new Types.ObjectId(authorId),
        title: dto.title,
        body: dto.body,
        status,
        tags: dto.tags,
      });
    },
  );

  it('defaults omitted tags to an empty array', async () => {
    postModel.create.mockResolvedValue({ _id: postId });

    await service.createPost(authorId, {
      title: 'Weekend in Alexandria',
      body: 'A travel story.',
      status: PostStatus.DRAFT,
    } as CreatePostDto);

    expect(postModel.create).toHaveBeenCalledWith(
      expect.objectContaining({ tags: [] }),
    );
  });

  it('rejects a malformed authenticated author ID', async () => {
    await expect(
      service.createPost('invalid', {
        title: 'Title',
        body: 'Body',
        status: PostStatus.DRAFT,
      } as CreatePostDto),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postModel.create).not.toHaveBeenCalled();
  });

  it('propagates post model failures', async () => {
    const databaseError = new Error('database unavailable');
    postModel.create.mockRejectedValue(databaseError);

    await expect(
      service.createPost(authorId, {
        title: 'Title',
        body: 'Body',
        status: PostStatus.DRAFT,
      } as CreatePostDto),
    ).rejects.toBe(databaseError);
  });

  it('creates a comment only after finding a visible published post', async () => {
    const query = {
      select: jest.fn(),
      exec: jest.fn().mockResolvedValue({ _id: postId }),
    };
    query.select.mockReturnValue(query);
    postModel.findOne.mockReturnValue(query);
    commentModel.create.mockResolvedValue({ _id: 'comment-id' });
    const dto = { body: 'Great trip.' } as CreateCommentDto;

    await service.createComment(authorId, postId, dto);

    expect(postModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(postId),
      status: PostStatus.PUBLISHED,
      isHidden: false,
    });
    expect(commentModel.create).toHaveBeenCalledWith({
      postId: new Types.ObjectId(postId),
      authorId: new Types.ObjectId(authorId),
      body: dto.body,
    });
  });

  it('rejects comments when the post is not published or visible', async () => {
    const query = {
      select: jest.fn(),
      exec: jest.fn().mockResolvedValue(null),
    };
    query.select.mockReturnValue(query);
    postModel.findOne.mockReturnValue(query);

    await expect(
      service.createComment(
        authorId,
        postId,
        { body: 'Hello' } as CreateCommentDto,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('rejects malformed post IDs before querying for a comment target', async () => {
    await expect(
      service.createComment(
        authorId,
        'invalid',
        { body: 'Hello' } as CreateCommentDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postModel.findOne).not.toHaveBeenCalled();
  });

  it('propagates post lookup failures and does not create a comment', async () => {
    const databaseError = new Error('database unavailable');
    const query = {
      select: jest.fn(),
      exec: jest.fn().mockRejectedValue(databaseError),
    };
    query.select.mockReturnValue(query);
    postModel.findOne.mockReturnValue(query);

    await expect(
      service.createComment(authorId, postId, {
        body: 'Hello',
      } as CreateCommentDto),
    ).rejects.toBe(databaseError);
    expect(commentModel.create).not.toHaveBeenCalled();
  });

  it('propagates comment model failures after confirming the post', async () => {
    const query = {
      select: jest.fn(),
      exec: jest.fn().mockResolvedValue({ _id: postId }),
    };
    query.select.mockReturnValue(query);
    postModel.findOne.mockReturnValue(query);
    const databaseError = new Error('database unavailable');
    commentModel.create.mockRejectedValue(databaseError);

    await expect(
      service.createComment(authorId, postId, {
        body: 'Hello',
      } as CreateCommentDto),
    ).rejects.toBe(databaseError);
  });

  it('atomically replaces tags for the owner with validators and permits clearing', async () => {
    const post = { _id: postId, tags: [] };
    const query = { exec: jest.fn().mockResolvedValue(post) };
    postModel.findOneAndUpdate.mockReturnValue(query);

    await service.updatePostTags(
      authorId,
      postId,
      { tags: [] } as UpdatePostTagsDto,
    );

    expect(postModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(authorId),
      },
      { $set: { tags: [] } },
      { new: true, runValidators: true },
    );
  });

  it('does not update a post owned by another user', async () => {
    const query = { exec: jest.fn().mockResolvedValue(null) };
    postModel.findOneAndUpdate.mockReturnValue(query);

    await expect(
      service.updatePostTags(
        authorId,
        postId,
        { tags: ['new'] } as UpdatePostTagsDto,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(postModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: new Types.ObjectId(postId),
        authorId: new Types.ObjectId(authorId),
      },
      { $set: { tags: ['new'] } },
      { new: true, runValidators: true },
    );
  });

  it('rejects malformed post IDs for tag updates', async () => {
    await expect(
      service.updatePostTags(
        authorId,
        'invalid',
        { tags: [] } as UpdatePostTagsDto,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(postModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('propagates atomic tag update model failures', async () => {
    const databaseError = new Error('database unavailable');
    postModel.findOneAndUpdate.mockReturnValue({
      exec: jest.fn().mockRejectedValue(databaseError),
    });

    await expect(
      service.updatePostTags(authorId, postId, {
        tags: [],
      } as UpdatePostTagsDto),
    ).rejects.toBe(databaseError);
  });
});
