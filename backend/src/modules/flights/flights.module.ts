
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
import {
  BaggagePolicy,
  BaggagePolicySchema,
} from '../airlines/schemas/baggage-policy.schema';
import {
  CancellationPolicy,
  CancellationPolicySchema,
} from '../airlines/schemas/cancellation-policy.schema';

@Module({
  imports: [
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
      // Existing airline policy schemas (owned by the airlines module),
      // registered here so FLT-17 can read them.
      {
        name: BaggagePolicy.name,
        schema: BaggagePolicySchema,
      },
      {
        name: CancellationPolicy.name,
        schema: CancellationPolicySchema,
      },
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
