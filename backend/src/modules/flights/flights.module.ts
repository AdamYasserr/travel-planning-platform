
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
import { FlightBookingsModule } from '../flight-bookings/flight-bookings.module';
import { ReferenceDataModule } from '../reference-data/reference-data.module';

@Module({
  imports: [
    FlightBookingsModule,
    ReferenceDataModule,
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
    ]),
  ],
  controllers: [
    FlightsController,
    CabinInventoryController,
  ],
  providers: [
    FlightsService,
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
