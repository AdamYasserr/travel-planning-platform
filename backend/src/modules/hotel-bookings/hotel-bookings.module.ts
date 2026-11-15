
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { User, UserSchema } from '../../users/user.schema';
import { HotelBooking, HotelBookingSchema } from './schemas/hotel-booking.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { HotelBookingsController } from './hotel-bookings.controller';
import { HotelBookingsService } from './hotel-bookings.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: Hotel.name, schema: HotelSchema },
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [HotelBookingsController],
  providers: [HotelBookingsService],
  exports: [MongooseModule, HotelBookingsService],
})
export class HotelBookingsModule {}
