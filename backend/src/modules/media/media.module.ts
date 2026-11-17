import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { Post, PostSchema } from '../blog/schemas/post.schema';
import {
  Itinerary,
  ItinerarySchema,
} from '../itineraries/schemas/itinerary.schema';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalMediaStorage } from './media.storage';
import { Media, MediaSchema } from './schemas/media.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Media.name, schema: MediaSchema },
      { name: User.name, schema: UserSchema },
      { name: Post.name, schema: PostSchema },
      { name: Itinerary.name, schema: ItinerarySchema },
    ]),
  ],
  controllers: [MediaController],
  providers: [MediaService, LocalMediaStorage],
  exports: [MediaService],
})
export class MediaModule {}
