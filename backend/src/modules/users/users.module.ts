import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { ReferenceDataModule } from '../reference-data/reference-data.module';
import { HotelBooking, HotelBookingSchema } from '../hotel-bookings/schemas/hotel-booking.schema';
import { FlightBooking, FlightBookingSchema } from '../flight-bookings/schemas/flight-booking.schema';
import { Post, PostSchema } from '../blog/schemas/post.schema';
import { Itinerary, ItinerarySchema } from '../itineraries/schemas/itinerary.schema';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    ReferenceDataModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: Post.name, schema: PostSchema },
      { name: Itinerary.name, schema: ItinerarySchema },
    ]),
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}