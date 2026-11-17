import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Attraction, AttractionSchema } from './schemas/attraction.schema';
import { City, CitySchema } from './schemas/city.schema';
import { Country, CountrySchema } from './schemas/country.schema';
import { ReferenceDataController } from './reference-data.controller';
import { ReferenceDataService } from './reference-data.service';
@Module({ imports: [MongooseModule.forFeature([{ name: Country.name, schema: CountrySchema }, { name: City.name, schema: CitySchema }, { name: Attraction.name, schema: AttractionSchema }])], controllers: [ReferenceDataController], providers: [ReferenceDataService], exports: [MongooseModule, ReferenceDataService] })
export class ReferenceDataModule {}
