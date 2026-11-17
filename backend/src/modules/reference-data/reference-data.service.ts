import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Country } from './schemas/country.schema';
import { City } from './schemas/city.schema';
import { Attraction } from './schemas/attraction.schema';
import { ReferenceQueryDto } from './dto/reference-query.dto';
@Injectable()
export class ReferenceDataService {
  constructor(
    @InjectModel(Country.name) private readonly countries: Model<Country>,
    @InjectModel(City.name) private readonly cities: Model<City>,
    @InjectModel(Attraction.name) private readonly attractions: Model<Attraction>,
  ) {}
  countriesList(q: ReferenceQueryDto) { return this.list(this.countries, q); }
  citiesList(q: ReferenceQueryDto) { return this.list(this.cities, q, q.parentId ? { countryId: q.parentId } : {}); }
  attractionsList(q: ReferenceQueryDto) { return this.list(this.attractions, q, q.parentId ? { cityId: q.parentId } : {}); }
  async currencies() { const items = await this.countries.distinct('currencyCode', { currencyCode: { $type: 'string', $ne: '' } }).exec(); return { items: items.filter((v): v is string => typeof v === 'string').map((v) => v.toUpperCase()).sort() }; }
  private async list<T>(m: Model<T>, q: ReferenceQueryDto, extra: Record<string, unknown> = {}) {
    const f: Record<string, unknown> = { ...extra };
    if (q.search?.trim()) f.name = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
    const page = q.page ?? 1, limit = q.limit ?? 50;
    const [items, totalItems] = await Promise.all([m.find(f).sort({ name: 1, sourceId: 1 }).skip((page - 1) * limit).limit(limit).lean().exec(), m.countDocuments(f).exec()]);
    return { items, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
  }
}
function escapeRegex(v: string) { return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
