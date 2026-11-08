import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';
import { LocalMediaStorage } from './media.storage';
import { Media, MediaSchema } from './schemas/media.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Media.name, schema: MediaSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [MediaController],
  providers: [MediaService, LocalMediaStorage],
  exports: [MediaService],
})
export class MediaModule {}