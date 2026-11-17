import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Country } from './schemas/country.schema';

const CACHE_TTL_MS = 60_000;

/** Supported currencies = distinct `currency` values of the imported Countries dataset. */
@Injectable()
export class SupportedCurrenciesService {
  private cache: { codes: string[]; expiresAt: number } | null = null;

  constructor(@InjectModel(Country.name) private readonly countries: Model<Country>) {}

  async list(): Promise<string[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.codes;
    const values = (await this.countries.distinct('currency').exec()) as unknown[];
    const codes = [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim().toUpperCase()))].sort();
    this.cache = { codes, expiresAt: Date.now() + CACHE_TTL_MS };
    return codes;
  }

  /** Returns the normalized (upper-case) code or throws 400. */
  async assertSupported(code: string, field = 'currency'): Promise<string> {
    const normalized = (code ?? '').trim().toUpperCase();
    const supported = await this.list();
    if (!supported.includes(normalized)) {
      throw new BadRequestException(`Unsupported ${field} "${code}". Supported currencies: ${supported.join(', ') || 'none (reference data not imported)'}`);
    }
    return normalized;
  }

  clearCache() {
    this.cache = null;
  }
}
