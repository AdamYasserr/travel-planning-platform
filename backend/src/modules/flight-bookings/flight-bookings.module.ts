import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  FlightBooking,
  FlightBookingSchema,
} from './schemas/flight-booking.schema';
import { FlightBookingsService } from './flight-bookings.service';
import {
  FlightBookingsController,
  FlightBookingsManagementController,
} from './flight-bookings.controller';
import { FlightBookingExpiryService } from './flight-booking-expiry.service';
import {
  FLIGHT_PAYMENTS_PORT,
  PendingFlightPaymentsAdapter,
} from './payments/flight-payments.port';

// FlightsModule exports its Mongoose models (Flight, CabinInventory, Airline,
// Airport, User, BaggagePolicy, CancellationPolicy), so none are re-registered.
import { FlightsModule } from '../flights/flights.module';

@Module({
  imports: [
    FlightsModule,
    MongooseModule.forFeature([
      { name: FlightBooking.name, schema: FlightBookingSchema },
    ]),
  ],
  controllers: [
    FlightBookingsController,
    FlightBookingsManagementController,
  ],
  providers: [
    FlightBookingsService,
    FlightBookingExpiryService,
    // TODO(PAY-01): Swap for the Stripe-backed adapter when payments support flights
    {
      provide: FLIGHT_PAYMENTS_PORT,
      useClass: PendingFlightPaymentsAdapter,
    },
  ],
  exports: [FlightBookingsService],
})
export class FlightBookingsModule {}
