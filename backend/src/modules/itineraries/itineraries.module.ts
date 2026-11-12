import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { FxRatesModule } from '../../integrations/fx-rates/fx-rates.module';
import { UsersModule } from '../users/users.module';
import { MediaModule } from '../media/media.module';
import { ActivityMediaController } from './activity-media.controller';
import { ItinerariesController } from './itineraries.controller';
import { ItinerariesService } from './itineraries.service';
import {
  Itinerary,
  ItinerarySchema,
} from './schemas/itinerary.schema';

@Module({
  imports: [
    FxRatesModule,
    UsersModule,
    MediaModule,
    MongooseModule.forFeature([
      {
        name: Itinerary.name,
        schema: ItinerarySchema,
      },
    ]),
  ],
  controllers: [
    ItinerariesController,
    ActivityMediaController,
  ],
  providers: [ItinerariesService],
})
export class ItinerariesModule {}