import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AdministrationController } from './administration.controller';
import { AdministrationService } from './administration.service';
import { User, UserSchema } from '../../users/user.schema';
import { Airline, AirlineSchema } from '../airlines/schemas/airline.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { FlightBooking, FlightBookingSchema } from '../flight-bookings/schemas/flight-booking.schema';
import { HotelBooking, HotelBookingSchema } from '../hotel-bookings/schemas/hotel-booking.schema';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Flight, FlightSchema } from '../flights/schemas/flight.schema';

@Module({
  imports: [AuditLogsModule, NotificationsModule, MongooseModule.forFeature([
    { name: User.name, schema: UserSchema },
    { name: Airline.name, schema: AirlineSchema },
    { name: Hotel.name, schema: HotelSchema },
    { name: FlightBooking.name, schema: FlightBookingSchema },
    { name: HotelBooking.name, schema: HotelBookingSchema },
    { name: Flight.name, schema: FlightSchema },
  ])],
  controllers: [AdministrationController],
  providers: [AdministrationService],
  exports: [AdministrationService],
})
export class AdministrationModule {}
