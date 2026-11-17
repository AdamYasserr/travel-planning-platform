import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import {
  CreateCommentDto,
  CreatePostDto,
  PostsQueryDto,
  SearchPostsQueryDto,
  UpdateCommentDto,
  UpdatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { BlogService } from './blog.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@Controller('blog/posts')
@ApiTags('Blog')
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'List published blog posts' })
  @ApiResponse({ status: 200, description: 'Published posts and pagination.' })
  listPublishedPosts(@Query() query: PostsQueryDto) {
    return this.blogService.listPublishedPosts(query);
  }

  @Get('search')
  @Public()
  @ApiOperation({ summary: 'Search published blog posts' })
  searchPublishedPosts(@Query() query: SearchPostsQueryDto) {
    return this.blogService.searchPublishedPosts(query);
  }

  @Get('mine')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'List your blog posts, including drafts' })
  listMyPosts(
    @Req() request: AuthenticatedRequest,
    @Query() query: PostsQueryDto,
  ) {
    return this.blogService.listMyPosts(request.user.userId, query);
  }

  @Get(':postId')
  @Public()
  @ApiOperation({ summary: 'Get a published blog post' })
  @ApiResponse({ status: 404, description: 'Published post not found.' })
  getPublishedPost(@Param('postId') postId: string) {
    return this.blogService.getPublishedPost(postId);
  }

  @Post()
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create a blog post' })
  @ApiBody({ type: CreatePostDto })
  @ApiResponse({ status: 201, description: 'Post created successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid post data.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  createPost(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreatePostDto,
  ) {
    return this.blogService.createPost(request.user.userId, dto);
  }

  @Patch(':postId')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Edit your blog post' })
  @ApiBody({ type: UpdatePostDto })
  updatePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Body() dto: UpdatePostDto,
  ) {
    return this.blogService.updatePost(request.user.userId, postId, dto);
  }

  @Delete(':postId')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Delete your blog post' })
  deletePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.blogService.deletePost(request.user.userId, postId);
  }

  @Post(':postId/like')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Like a published blog post' })
  likePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.blogService.likePost(request.user.userId, postId);
  }

  @Delete(':postId/like')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Remove your like from a blog post' })
  unlikePost(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
  ) {
    return this.blogService.unlikePost(request.user.userId, postId);
  }

  @Post(':postId/comments')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Comment on a published blog post' })
  @ApiBody({ type: CreateCommentDto })
  @ApiResponse({ status: 201, description: 'Comment created successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid post ID or comment.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 404, description: 'Published post not found.' })
  createComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.blogService.createComment(
      request.user.userId,
      postId,
      dto,
    );
  }

  @Patch(':postId/comments/:commentId')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Edit your comment on a published post' })
  @ApiBody({ type: UpdateCommentDto })
  updateComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.blogService.updateComment(
      request.user.userId,
      postId,
      commentId,
      dto,
    );
  }

  @Delete(':postId/comments/:commentId')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Delete your comment on a published post' })
  deleteComment(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Param('commentId') commentId: string,
  ) {
    return this.blogService.deleteComment(
      request.user.userId,
      postId,
      commentId,
    );
  }

  @Patch(':postId/tags')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Replace the tags on your blog post' })
  @ApiBody({ type: UpdatePostTagsDto })
  @ApiResponse({ status: 200, description: 'Post tags updated successfully.' })
  @ApiResponse({ status: 400, description: 'Invalid post ID or tags.' })
  @ApiResponse({ status: 401, description: 'Authentication is required.' })
  @ApiResponse({ status: 404, description: 'Post not found.' })
  updatePostTags(
    @Req() request: AuthenticatedRequest,
    @Param('postId') postId: string,
    @Body() dto: UpdatePostTagsDto,
  ) {
    return this.blogService.updatePostTags(
      request.user.userId,
      postId,
      dto,
    );
  }
}
