
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { FlightsController } from './flights.controller';
import { CabinInventoryService } from './cabin-inventory.service';
import { CabinInventoryController } from './cabin-inventory.controller';
import { FlightStatusService } from './flight-status.service';

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
