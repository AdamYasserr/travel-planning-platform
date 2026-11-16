import { jest } from '@jest/globals';
import {
  CanActivate,
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';

import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BlogAuthorController } from './blog-author.controller';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { PostStatus } from './enums/post-status.enum';

class TestAuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const userId = request.header('x-test-user-id');

    if (!userId) {
      if (
        Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler()) ||
        Reflect.getMetadata(IS_PUBLIC_KEY, context.getClass())
      ) {
        return true;
      }
      throw new UnauthorizedException();
    }

    request.user = {
      userId,
      role: request.header('x-test-role') ?? 'user',
    };
    return true;
  }
}

describe('BlogController Phase 1 HTTP integration', () => {
  const authorId = '507f1f77bcf86cd799439011';

  let app: INestApplication;
  let blogService: {
    createPost: jest.Mock;
    listPublishedPosts: jest.Mock;
    getPublishedPost: jest.Mock;
    listMyPosts: jest.Mock;
    searchPublishedPosts: jest.Mock;
    getAuthorPage: jest.Mock;
    updatePost: jest.Mock;
    deletePost: jest.Mock;
    likePost: jest.Mock;
    unlikePost: jest.Mock;
    createComment: jest.Mock;
    updateComment: jest.Mock;
    deleteComment: jest.Mock;
    updatePostTags: jest.Mock;
  };

  beforeAll(async () => {
    blogService = {
      createPost: jest.fn().mockResolvedValue({ _id: 'post-id' }),
      listPublishedPosts: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
      getPublishedPost: jest.fn().mockResolvedValue({ id: 'post-id' }),
      listMyPosts: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
      searchPublishedPosts: jest.fn().mockResolvedValue({ items: [], pagination: {} }),
      getAuthorPage: jest.fn().mockResolvedValue({ author: {}, posts: {}, publicItineraries: [] }),
      updatePost: jest.fn().mockResolvedValue({ _id: 'post-id' }),
      deletePost: jest.fn().mockResolvedValue({ message: 'Post deleted successfully' }),
      likePost: jest.fn().mockResolvedValue({ liked: true, likeCount: 1 }),
      unlikePost: jest.fn().mockResolvedValue({ liked: false, likeCount: 0 }),
      createComment: jest.fn().mockResolvedValue({ _id: 'comment-id' }),
      updateComment: jest.fn().mockResolvedValue({ _id: 'comment-id' }),
      deleteComment: jest.fn().mockResolvedValue({ message: 'Comment deleted successfully' }),
      updatePostTags: jest.fn().mockResolvedValue({ _id: 'post-id', tags: [] }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BlogController, BlogAuthorController],
      providers: [
        { provide: BlogService, useValue: blogService },
        { provide: APP_GUARD, useClass: TestAuthenticationGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows guests to list, search and open published posts', async () => {
    await request(app.getHttpServer()).get('/api/blog/posts').expect(200);
    await request(app.getHttpServer())
      .get('/api/blog/posts/search?keyword=coast')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/blog/posts/507f1f77bcf86cd799439012')
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/blog/authors/507f1f77bcf86cd799439011')
      .expect(200);

    expect(blogService.listPublishedPosts).toHaveBeenCalled();
    expect(blogService.searchPublishedPosts).toHaveBeenCalled();
    expect(blogService.getPublishedPost).toHaveBeenCalledWith(
      '507f1f77bcf86cd799439012',
    );
    expect(blogService.getAuthorPage).toHaveBeenCalledWith(
      authorId,
      expect.any(Object),
    );
  });

  it('requires authentication for own-post views and likes', async () => {
    await request(app.getHttpServer()).get('/api/blog/posts/mine').expect(401);
    await request(app.getHttpServer())
      .post('/api/blog/posts/507f1f77bcf86cd799439012/like')
      .expect(401);
  });

  it('routes authenticated post management and like actions with JWT identity', async () => {
    await request(app.getHttpServer())
      .get('/api/blog/posts/mine')
      .set('x-test-user-id', authorId)
      .expect(200);
    await request(app.getHttpServer())
      .patch('/api/blog/posts/507f1f77bcf86cd799439012')
      .set('x-test-user-id', authorId)
      .send({ title: 'Updated' })
      .expect(200);
    await request(app.getHttpServer())
      .post('/api/blog/posts/507f1f77bcf86cd799439012/like')
      .set('x-test-user-id', authorId)
      .expect(201);
    await request(app.getHttpServer())
      .delete('/api/blog/posts/507f1f77bcf86cd799439012/like')
      .set('x-test-user-id', authorId)
      .expect(200);

    expect(blogService.listMyPosts).toHaveBeenCalledWith(
      authorId,
      expect.any(Object),
    );
    expect(blogService.updatePost).toHaveBeenCalledWith(
      authorId,
      '507f1f77bcf86cd799439012',
      { title: 'Updated' },
    );
    expect(blogService.likePost).toHaveBeenCalledWith(
      authorId,
      '507f1f77bcf86cd799439012',
    );
    expect(blogService.unlikePost).toHaveBeenCalledWith(
      authorId,
      '507f1f77bcf86cd799439012',
    );
  });

  it('requires authentication to create posts', async () => {
    await request(app.getHttpServer())
      .post('/api/blog/posts')
      .send({ title: 'Trip', body: 'Story', status: PostStatus.DRAFT })
      .expect(401);
  });

  it('passes the authenticated identity to post creation', async () => {
    await request(app.getHttpServer())
      .post('/api/blog/posts')
      .set('x-test-user-id', authorId)
      .send({ title: 'Trip', body: 'Story', status: PostStatus.PUBLISHED })
      .expect(201);

    expect(blogService.createPost).toHaveBeenCalledWith(
      authorId,
      expect.objectContaining({ status: PostStatus.PUBLISHED }),
    );
  });

  it('rejects client-supplied author and image IDs on post creation', async () => {
    await request(app.getHttpServer())
      .post('/api/blog/posts')
      .set('x-test-user-id', authorId)
      .send({
        title: 'Trip',
        body: 'Story',
        status: PostStatus.DRAFT,
        authorId: '507f1f77bcf86cd799439013',
        imageIds: ['507f1f77bcf86cd799439014'],
      })
      .expect(400);

    expect(blogService.createPost).not.toHaveBeenCalled();
  });

  it('rejects roles other than registered users', async () => {
    await request(app.getHttpServer())
      .post('/api/blog/posts')
      .set('x-test-user-id', authorId)
      .set('x-test-role', 'admin')
      .send({ title: 'Trip', body: 'Story', status: PostStatus.DRAFT })
      .expect(403);
  });

  it('routes authenticated comment creation with the path post ID', async () => {
    await request(app.getHttpServer())
      .post('/api/blog/posts/507f1f77bcf86cd799439012/comments')
      .set('x-test-user-id', authorId)
      .send({ body: 'A comment.' })
      .expect(201);

    expect(blogService.createComment).toHaveBeenCalledWith(
      authorId,
      '507f1f77bcf86cd799439012',
      { body: 'A comment.' },
    );
  });

  it('routes tag replacement and rejects client-supplied author identity', async () => {
    await request(app.getHttpServer())
      .patch('/api/blog/posts/507f1f77bcf86cd799439012/tags')
      .set('x-test-user-id', authorId)
      .send({ tags: [] })
      .expect(200);

    expect(blogService.updatePostTags).toHaveBeenCalledWith(
      authorId,
      '507f1f77bcf86cd799439012',
      { tags: [] },
    );

    await request(app.getHttpServer())
      .patch('/api/blog/posts/507f1f77bcf86cd799439012/tags')
      .set('x-test-user-id', authorId)
      .send({ tags: ['Egypt'], authorId: '507f1f77bcf86cd799439013' })
      .expect(400);
  });
});
