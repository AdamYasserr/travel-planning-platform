import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Attraction } from './schemas/attraction.schema';
import { City } from './schemas/city.schema';
import { Country } from './schemas/country.schema';
import { ReferenceQueryDto } from './dto/reference-query.dto';
import { SupportedCurrenciesService } from './supported-currencies.service';

const PROJECTION = { _id: 0, __v: 0, createdAt: 0, updatedAt: 0 };

@Injectable()
export class ReferenceDataService {
  constructor(
    @InjectModel(Country.name) private readonly countries: Model<Country>,
    @InjectModel(City.name) private readonly cities: Model<City>,
    @InjectModel(Attraction.name) private readonly attractions: Model<Attraction>,
    private readonly currencyService: SupportedCurrenciesService,
  ) {}

  countriesList(q: ReferenceQueryDto) {
    return this.list(this.countries, q, {}, { name: 1, code: 1 });
  }

  citiesList(q: ReferenceQueryDto) {
    return this.list(this.cities, q, q.parentId ? { countryCode: q.parentId.trim().toUpperCase() } : {}, { name: 1, cityId: 1 });
  }

  attractionsList(q: ReferenceQueryDto) {
    return this.list(this.attractions, q, q.parentId ? { cityId: q.parentId.trim() } : {}, { name: 1, attractionId: 1 });
  }

  async currencies() {
    return { items: await this.currencyService.list() };
  }

  private async list<T>(m: Model<T>, q: ReferenceQueryDto, extra: Record<string, unknown>, sort: Record<string, 1>) {
    const f: Record<string, unknown> = { ...extra };
    if (q.search?.trim()) f.name = { $regex: escapeRegex(q.search.trim()), $options: 'i' };
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const [items, totalItems] = await Promise.all([
      m.find(f, PROJECTION).sort(sort).skip((page - 1) * limit).limit(limit).lean().exec(),
      m.countDocuments(f).exec(),
    ]);
    return { items, pagination: { page, limit, totalItems, totalPages: Math.ceil(totalItems / limit) } };
  }
}

function escapeRegex(v: string) {
  return v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
