import {
  Body,
  Controller,
  Param,
  Patch,
  Post,
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

import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/enums/user-role.enum';
import {
  CreateCommentDto,
  CreatePostDto,
  UpdatePostTagsDto,
} from './dto/blog.dto';
import { BlogService } from './blog.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@Controller('blog/posts')
@ApiTags('Blog')
@ApiCookieAuth('access_token')
@Roles(UserRole.USER)
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  @Post()
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

  @Post(':postId/comments')
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

  @Patch(':postId/tags')
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
