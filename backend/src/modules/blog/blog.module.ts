import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from '../../users/user.schema';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { MediaModule } from '../media/media.module';
import {
  BlogAuthorsController,
  BlogController,
  BlogTagsController,
  CommentsController,
} from './blog.controller';
import { BlogService } from './blog.service';
import { Comment, CommentSchema } from './schemas/comment.schema';
import { Like, LikeSchema } from './schemas/like.schema';
import { Post, PostSchema } from './schemas/post.schema';

@Module({
  imports: [
    MediaModule,
    AuditLogsModule,
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: Like.name, schema: LikeSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [
    BlogController,
    CommentsController,
    BlogTagsController,
    BlogAuthorsController,
  ],
  providers: [BlogService],
  exports: [BlogService, MongooseModule],
})
export class BlogModule {}
