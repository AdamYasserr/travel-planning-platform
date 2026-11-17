import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { HotelsController } from './hotels.controller';
import { HotelsService } from './hotels.service';
import { Hotel, HotelSchema } from './schemas/hotel.schema';
import { Room, RoomSchema } from './schemas/room.schema';
import { HotelBookingsModule } from '../hotel-bookings/hotel-bookings.module';
import { Review, ReviewSchema } from './schemas/review.schema';
import { ReferenceDataModule } from '../reference-data/reference-data.module';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';
import { HotelReservationsService } from './hotel-reservations.service';
import { HotelSearchService } from './hotel-search.service';
import { City, CitySchema } from '../reference-data/schemas/city.schema';
import { Country, CountrySchema } from '../reference-data/schemas/country.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Hotel.name, schema: HotelSchema },
      { name: Room.name, schema: RoomSchema },
      { name: User.name, schema: UserSchema },
      { name: Review.name, schema: ReviewSchema },
      { name: City.name, schema: CitySchema },
      { name: Country.name, schema: CountrySchema },
    ]),
    HotelBookingsModule,
    ReferenceDataModule,
  ],
  controllers: [HotelsController, ReviewsController],
  providers: [HotelsService, HotelSearchService, HotelReservationsService, ReviewsService],
  exports: [MongooseModule, HotelsService, HotelSearchService],
})
export class HotelsModule {}