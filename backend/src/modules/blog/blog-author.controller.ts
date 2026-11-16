import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import { PostsQueryDto } from './dto/blog.dto';
import { BlogService } from './blog.service';

@Controller('blog/authors')
@ApiTags('Blog')
export class BlogAuthorController {
  constructor(private readonly blogService: BlogService) {}

  @Get(':authorId')
  @Public()
  @ApiOperation({ summary: 'Get an author profile and public travel content' })
  getAuthorPage(
    @Param('authorId') authorId: string,
    @Query() query: PostsQueryDto,
  ) {
    return this.blogService.getAuthorPage(authorId, query);
  }
}
