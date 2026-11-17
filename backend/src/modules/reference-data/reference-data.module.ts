import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Airport, AirportSchema } from '../airports/schemas/airport.schema';
import { Attraction, AttractionSchema } from './schemas/attraction.schema';
import { City, CitySchema } from './schemas/city.schema';
import { Country, CountrySchema } from './schemas/country.schema';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';
import { ReferenceValidationService } from './reference-validation.service';
import { SupportedCurrenciesService } from './supported-currencies.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Country.name, schema: CountrySchema },
      { name: City.name, schema: CitySchema },
      { name: Attraction.name, schema: AttractionSchema },
      { name: Airport.name, schema: AirportSchema },
    ]),
  ],
  controllers: [ReferenceDataController],
  providers: [ReferenceDataService, ReferenceValidationService, SupportedCurrenciesService],
  exports: [MongooseModule, ReferenceDataService, ReferenceValidationService, SupportedCurrenciesService],
})
export class ReferenceDataModule {}
