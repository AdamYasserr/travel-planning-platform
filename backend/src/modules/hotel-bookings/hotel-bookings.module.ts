import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  HotelBooking,
  HotelBookingSchema,
} from './schemas/hotel-booking.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { Room, RoomSchema } from '../hotels/schemas/room.schema';
import { HotelBookingsController } from './hotel-bookings.controller';
import { HotelBookingsService } from './hotel-bookings.service';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    PaymentsModule,
    MongooseModule.forFeature([
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: Hotel.name, schema: HotelSchema },
      { name: Room.name, schema: RoomSchema },
    ]),
  ],
  controllers: [HotelBookingsController],
  providers: [HotelBookingsService],
  exports: [MongooseModule],
})
export class HotelBookingsModule {}
