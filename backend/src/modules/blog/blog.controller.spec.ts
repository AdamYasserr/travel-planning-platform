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

import { RolesGuard } from '../../common/guards/roles.guard';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { PostStatus } from './enums/post-status.enum';

class TestAuthenticationGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const userId = request.header('x-test-user-id');

    if (!userId) {
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
    createComment: jest.Mock;
    updatePostTags: jest.Mock;
  };

  beforeAll(async () => {
    blogService = {
      createPost: jest.fn().mockResolvedValue({ _id: 'post-id' }),
      createComment: jest.fn().mockResolvedValue({ _id: 'comment-id' }),
      updatePostTags: jest.fn().mockResolvedValue({ _id: 'post-id', tags: [] }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [BlogController],
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
