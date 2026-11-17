import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Airport, AirportDocument } from './schemas/airport.schema';
import { City } from '../reference-data/schemas/city.schema';
import { Country } from '../reference-data/schemas/country.schema';
import { AirportQueryDto } from './dto/airport-query.dto';

@Injectable()
export class AirportsService {
  constructor(
    @InjectModel(Airport.name) private readonly airportModel: Model<AirportDocument>,
    @InjectModel(City.name) private readonly cityModel: Model<City>,
    @InjectModel(Country.name) private readonly countryModel: Model<Country>,
  ) {}

  async findAll(query: Partial<AirportQueryDto> = {}) {
    const filter: Record<string, unknown> = {};
    if (query.countryCode) filter.countryCode = query.countryCode.trim().toUpperCase();
    if (query.cityId) filter.cityId = query.cityId.trim();
    if (query.search?.trim()) {
      const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{ name: { $regex: term, $options: 'i' } }, { iataCode: { $regex: term, $options: 'i' } }];
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const [airports, totalItems] = await Promise.all([
      this.airportModel.find(filter).sort({ name: 1, iataCode: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(),
      this.airportModel.countDocuments(filter).exec(),
    ]);
    const cityIds = [...new Set(airports.map((a) => a.cityId))];
    const countryCodes = [...new Set(airports.map((a) => a.countryCode))];
    const [cities, countries] = await Promise.all([
      this.cityModel.find({ cityId: { $in: cityIds } }).select('cityId name').lean().exec(),
      this.countryModel.find({ code: { $in: countryCodes } }).select('code name').lean().exec(),
    ]);
    const cityName = new Map(cities.map((c) => [c.cityId, c.name]));
    const countryName = new Map(countries.map((c) => [c.code, c.name]));
    const items = airports.map((a) => ({
      iata_code: a.iataCode,
      name: a.name,
      city: cityName.get(a.cityId) ?? a.cityId,
      city_id: a.cityId,
      country: countryName.get(a.countryCode) ?? a.countryCode,
      country_code: a.countryCode,
      time_zone: a.timeZone,
    }));
    return { items, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
  }
}
