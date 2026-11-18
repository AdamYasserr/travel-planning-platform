import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Airport } from '../airports/schemas/airport.schema';
import { City } from './schemas/city.schema';
import { Country } from './schemas/country.schema';

/** Verifies that dataset identifiers (country code, city_id, IATA code) exist. Throws 400 otherwise. */
@Injectable()
export class ReferenceValidationService {
  constructor(
    @InjectModel(Country.name) private readonly countries: Model<Country>,
    @InjectModel(City.name) private readonly cities: Model<City>,
    @InjectModel(Airport.name) private readonly airports: Model<Airport>,
  ) {}

  /** The given country codes (any case) that are NOT in the Countries list, upper-cased. */
  async unknownCountryCodes(codes: string[]): Promise<string[]> {
    const wanted = unique(codes.map((c) => String(c).trim().toUpperCase()));
    const found = new Set((await this.countries.find({ code: { $in: wanted } }).select('code').lean().exec()).map((d) => d.code));
    return wanted.filter((code) => !found.has(code));
  }

  async assertCountryCodes(codes: string[], field = 'countryId'): Promise<string[]> {
    const wanted = unique(codes.map((c) => String(c).trim().toUpperCase()));
    const found = await this.countries.find({ code: { $in: wanted } }).select('code').lean().exec();
    this.assertAllFound(wanted, found.map((d) => d.code), 'country', field);
    return wanted;
  }

  async assertCityIds(ids: string[], field = 'cityId'): Promise<string[]> {
    const wanted = unique(ids.map((c) => String(c).trim()));
    const found = await this.cities.find({ cityId: { $in: wanted } }).select('cityId').lean().exec();
    this.assertAllFound(wanted, found.map((d) => d.cityId), 'city', field);
    return wanted;
  }

  async assertAirportCodes(codes: string[], field = 'airport'): Promise<string[]> {
    const wanted = unique(codes.map((c) => String(c).trim().toUpperCase()));
    const found = await this.airports.find({ iataCode: { $in: wanted } }).select('iataCode').lean().exec();
    this.assertAllFound(wanted, found.map((d) => d.iataCode), 'airport', field);
    return wanted;
  }

  /** Validates a city together with its country: the city must belong to the given country. */
  async assertCityInCountry(cityId: string, countryCode: string): Promise<void> {
    const [city] = await this.assertCityIds([cityId]);
    const [country] = await this.assertCountryCodes([countryCode]);
    const doc = await this.cities.findOne({ cityId: city }).select('countryCode').lean().exec();
    if (doc && doc.countryCode !== country) {
      throw new BadRequestException(`City "${city}" does not belong to country "${country}"`);
    }
  }

  private assertAllFound(wanted: string[], found: string[], kind: string, field: string) {
    const set = new Set(found);
    const missing = wanted.filter((w) => !set.has(w));
    if (missing.length) {
      throw new BadRequestException(`Unknown ${kind} identifier(s) for ${field}: ${missing.join(', ')}. Use an identifier from the reference dataset.`);
    }
  }
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
