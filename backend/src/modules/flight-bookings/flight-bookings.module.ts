import { Module, forwardRef } from '@nestjs/common';
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
  StripeFlightPaymentsAdapter,
} from './payments/flight-payments.port';
import { PaymentsModule } from '../payments/payments.module';

// FlightsModule exports its Mongoose models (Flight, CabinInventory, Airline,
// Airport, User, BaggagePolicy, CancellationPolicy), so none are re-registered.
import { FlightsModule } from '../flights/flights.module';

@Module({
  imports: [
    FlightsModule,
    MongooseModule.forFeature([
      { name: FlightBooking.name, schema: FlightBookingSchema },
    ]),
    // FLT-23: Payments confirms flight bookings; flight bookings refunds and
    // cancels through payments. The cycle is resolved with forwardRef.
    forwardRef(() => PaymentsModule),
  ],
  controllers: [
    FlightBookingsController,
    FlightBookingsManagementController,
  ],
  providers: [
    FlightBookingsService,
    FlightBookingExpiryService,
    // PAY-01 / PAY-03: Stripe through the shared PaymentsService
    {
      provide: FLIGHT_PAYMENTS_PORT,
      useClass: StripeFlightPaymentsAdapter,
    },
  ],
  exports: [FlightBookingsService],
})
export class FlightBookingsModule {}
