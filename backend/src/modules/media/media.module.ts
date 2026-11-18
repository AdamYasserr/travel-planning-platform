import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { Airline, AirlineSchema } from '../airlines/schemas/airline.schema';
import { Post, PostSchema } from '../blog/schemas/post.schema';
import { Comment, CommentSchema } from '../blog/schemas/comment.schema';
import { Itinerary, ItinerarySchema } from '../itineraries/schemas/itinerary.schema';

import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalMediaStorage } from './media.storage';
import { Media, MediaSchema } from './schemas/media.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Media.name, schema: MediaSchema },
      { name: User.name, schema: UserSchema },
      { name: Hotel.name, schema: HotelSchema },
      { name: Airline.name, schema: AirlineSchema },
      { name: Post.name, schema: PostSchema },
      { name: Comment.name, schema: CommentSchema },
      { name: Itinerary.name, schema: ItinerarySchema },
    ]),
  ],
  controllers: [MediaController],
  providers: [MediaService, LocalMediaStorage],
  exports: [MediaService],
})
export class MediaModule {}
