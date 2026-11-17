
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FlightsController } from './flights.controller';
import { CabinInventoryService } from './cabin-inventory.service';
import { CabinInventoryController } from './cabin-inventory.controller';
import { FlightStatusService } from './flight-status.service';
import {
  Airport,
  AirportSchema,
} from '../airports/schemas/airport.schema';

import {
  Flight,
  FlightSchema,
} from './schemas/flight.schema';

import {
  CabinInventory,
  CabinInventorySchema,
} from './schemas/cabin-inventory.schema';

import {
  Airline,
  AirlineSchema,
} from '../airlines/schemas/airline.schema';

import { User, UserSchema } from '../../users/user.schema';

import { FlightsService } from './flights.service';
import { FlightSearchService } from './flight-search.service';
import { BaggagePolicy, BaggagePolicySchema } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy, CancellationPolicySchema } from '../airlines/schemas/cancellation-policy.schema';
import { City, CitySchema } from '../reference-data/schemas/city.schema';
import { FlightBookingsModule } from '../flight-bookings/flight-bookings.module';
import { ReferenceDataModule } from '../reference-data/reference-data.module';
import { PaymentsModule } from '../payments/payments.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    FlightBookingsModule,
    ReferenceDataModule,
    PaymentsModule,
    NotificationsModule,
    MongooseModule.forFeature([
      {
        name: Flight.name,
        schema: FlightSchema,
      },
      {
        name: CabinInventory.name,
        schema: CabinInventorySchema,
      },
      {
        name: Airline.name,
        schema: AirlineSchema,
      },
      {
        name: User.name,
        schema: UserSchema,
      },
      {
  name: Airport.name,
  schema: AirportSchema,
},
      { name: BaggagePolicy.name, schema: BaggagePolicySchema },
      { name: CancellationPolicy.name, schema: CancellationPolicySchema },
      { name: City.name, schema: CitySchema },
    ]),
  ],
  controllers: [
    FlightsController,
    CabinInventoryController,
  ],
  providers: [
    FlightsService,
    FlightSearchService,
    CabinInventoryService,
    FlightStatusService,
  ],
  exports: [
    MongooseModule,
    FlightsService,
    CabinInventoryService,
  ],
})
export class FlightsModule {}
