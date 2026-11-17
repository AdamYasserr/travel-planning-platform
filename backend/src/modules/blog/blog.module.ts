import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { MediaModule } from '../media/media.module';
import { ItinerariesModule } from '../itineraries/itineraries.module';

import { BlogController } from './blog.controller';
import { BlogAuthorController } from './blog-author.controller';
import { BlogService } from './blog.service';
import { Comment, CommentSchema } from './schemas/comment.schema';
import { Post, PostSchema } from './schemas/post.schema';
import { PostLike, PostLikeSchema } from './schemas/post-like.schema';
import { User, UserSchema } from '../../users/user.schema';

@Module({
  imports: [
    MediaModule,
    ItinerariesModule,
    MongooseModule.forFeature([
      { name: Post.name, schema: PostSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: PostLike.name, schema: PostLikeSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [BlogController, BlogAuthorController],
  providers: [BlogService],
})
export class BlogModule {}
