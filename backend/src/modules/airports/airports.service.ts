import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Airport, AirportDocument } from './schemas/airport.schema';
import { AirportQueryDto } from './dto/airport-query.dto';
@Injectable()
export class AirportsService {
  constructor(@InjectModel(Airport.name) private readonly airportModel: Model<AirportDocument>) {}
  async findAll(query: Partial<AirportQueryDto> = {}) {
    const filter: Record<string, unknown> = {};
    if (query.countryId) filter.countryId = query.countryId;
    if (query.search?.trim()) { const term = query.search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); filter.$or = [{ name: { $regex: term, $options: 'i' } }, { iataCode: { $regex: term, $options: 'i' } }]; }
    const page = query.page ?? 1, limit = query.limit ?? 50;
    const [items, totalItems] = await Promise.all([this.airportModel.find(filter).sort({ name: 1, sourceId: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(), this.airportModel.countDocuments(filter).exec()]);
    return { items, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
  }
}
