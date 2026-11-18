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
  UploadedFile,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiConsumes,
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { PageQueryDto } from '../../common/pagination/pagination';
import { Public } from '../../common/decorators/public.decorator';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';
import { ImageUpload } from '../media/media.limits';
import { MediaService } from '../media/media.service';
import { MediaTargetType } from '../media/dto/upload-media.dto';
import {
  CreateCommentDto,
  CreatePostDto,
  PostListQueryDto,
  UpdatePostDto,
} from './dto/blog.dto';
import { BlogService } from './blog.service';

type UserRequest = Request & { user?: { userId: string } };
type RequiredUserRequest = Request & { user: { userId: string } };
type ImageFile = {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
};

@Controller('posts')
@ApiTags('Blog Posts')
export class BlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly media: MediaService,
  ) {}

  @Post()
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create a draft or published blog post' })
  create(@Req() req: RequiredUserRequest, @Body() dto: CreatePostDto) {
    return this.blog.createPost(req.user.userId, dto);
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'Browse and search published posts' })
  list(@Query() query: PostListQueryDto) {
    return this.blog.listPosts(query);
  }

  @Get('mine')
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'List the signed-in author’s posts, including drafts',
  })
  mine(@Req() req: RequiredUserRequest, @Query() query: PostListQueryDto) {
    return this.blog.listMine(req.user.userId, query);
  }

  @Public()
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'View a published post or your own draft' })
  get(@Param('id') id: string, @Req() req: UserRequest) {
    return this.blog.getPost(id, req.user?.userId);
  }

  @Patch(':id')
  @ApiCookieAuth('access_token')
  update(
    @Param('id') id: string,
    @Req() req: RequiredUserRequest,
    @Body() dto: UpdatePostDto,
  ) {
    return this.blog.updatePost(req.user.userId, id, dto);
  }

  @Delete(':id')
  @ApiCookieAuth('access_token')
  remove(@Param('id') id: string, @Req() req: RequiredUserRequest) {
    return this.blog.deletePost(req.user.userId, id);
  }

  @Post(':id/comments')
  @ApiCookieAuth('access_token')
  addComment(
    @Param('id') id: string,
    @Req() req: RequiredUserRequest,
    @Body() dto: CreateCommentDto,
  ) {
    return this.blog.addComment(req.user.userId, id, dto);
  }

  @Public()
  @Get(':id/comments')
  listComments(@Param('id') id: string, @Query() query: PageQueryDto) {
    // GEN-05: 10 per page by default, limit up to 100; a bad page or limit is a 400 on that field.
    return this.blog.listComments(id, query.page, query.limit);
  }

  @Post(':id/like')
  @ApiCookieAuth('access_token')
  like(@Param('id') id: string, @Req() req: RequiredUserRequest) {
    return this.blog.likePost(req.user.userId, id);
  }

  @Delete(':id/like')
  @ApiCookieAuth('access_token')
  unlike(@Param('id') id: string, @Req() req: RequiredUserRequest) {
    return this.blog.unlikePost(req.user.userId, id);
  }

  @Post(':id/images')
  @ApiCookieAuth('access_token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ImageUpload()
  uploadImage(
    @Param('id') id: string,
    @Req() req: RequiredUserRequest,
    @UploadedFile() file?: ImageFile,
  ) {
    return this.media.upload(
      req.user.userId,
      { targetType: MediaTargetType.POST, targetId: id },
      file,
    );
  }

  @Delete(':id/images/:imageId')
  @ApiCookieAuth('access_token')
  removeImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @Req() req: RequiredUserRequest,
  ) {
    return this.media.removeTargetMedia(
      req.user.userId,
      MediaTargetType.POST,
      id,
      imageId,
    );
  }
}

@Controller('comments')
@ApiTags('Blog Comments')
@ApiCookieAuth('access_token')
export class CommentsController {
  constructor(private readonly blog: BlogService) {}

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Req() req: RequiredUserRequest,
    @Body() dto: CreateCommentDto,
  ) {
    return this.blog.updateComment(req.user.userId, id, dto.body);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: RequiredUserRequest) {
    return this.blog.deleteComment(req.user.userId, id);
  }
}

@Controller('tags')
@ApiTags('Blog Tags')
export class BlogTagsController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get(':tag/posts')
  posts(@Param('tag') tag: string, @Query() query: PostListQueryDto) {
    return this.blog.listPostsByTag(tag, query);
  }
}

@Controller('authors')
@ApiTags('Blog Authors')
export class BlogAuthorsController {
  constructor(private readonly blog: BlogService) {}

  @Public()
  @Get(':id')
  author(@Param('id') id: string, @Query() query: PageQueryDto) {
    return this.blog.authorPage(id, query);
  }
}
