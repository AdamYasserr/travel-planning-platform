import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  CabinInventory,
  CabinInventorySchema,
} from '../flights/schemas/cabin-inventory.schema';
import { Flight, FlightSchema } from '../flights/schemas/flight.schema';
import {
  CancellationPolicy,
  CancellationPolicySchema,
} from '../airlines/schemas/cancellation-policy.schema';
import { BaggagePolicy, BaggagePolicySchema } from '../airlines/schemas/baggage-policy.schema';
import { PaymentsModule } from '../payments/payments.module';
import { FlightBookingsController } from './flight-bookings.controller';
import { FlightBookingsService } from './flight-bookings.service';
import {
  FlightBooking,
  FlightBookingSchema,
} from './schemas/flight-booking.schema';

@Module({
  imports: [
    PaymentsModule,
    MongooseModule.forFeature([
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: Flight.name, schema: FlightSchema },
      { name: CabinInventory.name, schema: CabinInventorySchema },
      { name: CancellationPolicy.name, schema: CancellationPolicySchema },
      { name: BaggagePolicy.name, schema: BaggagePolicySchema },
    ]),
  ],
  controllers: [FlightBookingsController],
  providers: [FlightBookingsService],
  exports: [MongooseModule, FlightBookingsService],
})
export class FlightBookingsModule {}
