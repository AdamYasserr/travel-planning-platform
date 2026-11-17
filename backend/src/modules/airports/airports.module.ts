
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Airport,
  AirportSchema,
} from './schemas/airport.schema';

import { City, CitySchema } from '../reference-data/schemas/city.schema';
import { Country, CountrySchema } from '../reference-data/schemas/country.schema';
import { AirportsController } from './airports.controller';
import { AirportsService } from './airports.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      {
        name: Airport.name,
        schema: AirportSchema,
      },
      { name: City.name, schema: CitySchema },
      { name: Country.name, schema: CountrySchema },
    ]),
  ],
  controllers: [AirportsController],
  providers: [AirportsService],
  exports: [MongooseModule, AirportsService],
})
export class AirportsModule {}
