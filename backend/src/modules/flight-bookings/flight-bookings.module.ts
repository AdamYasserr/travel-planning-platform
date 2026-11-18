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
import { ReferenceDataModule } from '../reference-data/reference-data.module';
import { Airline, AirlineSchema } from '../airlines/schemas/airline.schema';
import { Airport, AirportSchema } from '../airports/schemas/airport.schema';
import { ETicketController } from './e-ticket/e-ticket.controller';
import { ETicketService } from './e-ticket/e-ticket.service';
import { FlightBookingsController } from './flight-bookings.controller';
import { FlightBookingsService } from './flight-bookings.service';
import {
  FlightBooking,
  FlightBookingSchema,
} from './schemas/flight-booking.schema';

@Module({
  imports: [
    PaymentsModule,
    ReferenceDataModule,
    MongooseModule.forFeature([
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: Flight.name, schema: FlightSchema },
      { name: CabinInventory.name, schema: CabinInventorySchema },
      { name: CancellationPolicy.name, schema: CancellationPolicySchema },
      { name: BaggagePolicy.name, schema: BaggagePolicySchema },
      { name: Airline.name, schema: AirlineSchema },
      { name: Airport.name, schema: AirportSchema },
    ]),
  ],
  controllers: [FlightBookingsController, ETicketController],
  providers: [FlightBookingsService, ETicketService],
  exports: [MongooseModule, FlightBookingsService],
})
export class FlightBookingsModule {}
