import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { firstValueFrom } from 'rxjs';
import { ExchangeRate } from './schemas/exchange-rate.schema';

interface ProviderResponse {
  rates?: Record<string, number>;
}

interface CachedRates {
  rates: Record<string, number>;
  fetchedAt: number;
}

const DAILY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class FxRatesService {
  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    @InjectModel(ExchangeRate.name)
    private readonly exchangeRateModel: Model<ExchangeRate>,
  ) {}

  async getRate(from: string, to: string) {
    const base = this.normalizeCurrency(from);
    const target = this.normalizeCurrency(to);

    if (base === target) {
      return { from: base, to: target, rate: 1, stale: false };
    }

    const rates = await this.getRates(base, target);
    const rate = rates.rates[target];

    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      throw new BadRequestException(
        `Exchange rate for ${base} to ${target} is unavailable`,
      );
    }

    return {
      from: base,
      to: target,
      rate,
      stale: Date.now() - rates.fetchedAt > DAILY_CACHE_TTL_MS,
      fetchedAt: new Date(rates.fetchedAt).toISOString(),
    };
  }

  async convert(amount: number, from: string, to: string) {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new BadRequestException(
        'Conversion amount must be a finite non-negative number',
      );
    }

    const quote = await this.getRate(from, to);
    const convertedAmount = amount * quote.rate;

    if (!Number.isFinite(convertedAmount)) {
      throw new BadRequestException(
        'The converted amount is outside the supported numeric range',
      );
    }

    return {
      ...quote,
      amount,
      convertedAmount: Number(convertedAmount.toFixed(2)),
    };
  }

  private async getRates(
    base: string,
    target: string,
  ): Promise<CachedRates> {
    const pair = {
      baseCurrency: base,
      targetCurrency: target,
    };

    const cachedDocument = await this.exchangeRateModel
      .findOne(pair)
      .lean()
      .exec();

    const cached: CachedRates | undefined = cachedDocument
      ? {
          rates: { [target]: cachedDocument.rate },
          fetchedAt: cachedDocument.fetchedAt.getTime(),
        }
      : undefined;

    const now = Date.now();

    if (cached && now - cached.fetchedAt < DAILY_CACHE_TTL_MS) {
      return cached;
    }

    try {
      const baseUrl = this.configService.getOrThrow<string>(
        'fxRates.baseUrl',
      );
      const apiKey = this.configService.get<string>('fxRates.apiKey');
      const endpoint = this.buildLatestEndpoint(baseUrl);

      const response = await firstValueFrom(
        this.httpService.get<ProviderResponse>(endpoint, {
          timeout: 5000,
          params: {
            base,
            symbols: target,
            ...(apiKey ? { apikey: apiKey } : {}),
          },
        }),
      );

      const providerRates = response.data?.rates;
      const rate = providerRates?.[target];

      if (
        !providerRates ||
        typeof providerRates !== 'object' ||
        Array.isArray(providerRates) ||
        typeof rate !== 'number' ||
        !Number.isFinite(rate) ||
        rate <= 0
      ) {
        throw new Error(
          'Provider response did not contain the requested rate',
        );
      }

      const fetchedAt = new Date(now);

      const savedRate = await this.exchangeRateModel
        .findOneAndUpdate(
          pair,
          {
            $set: {
              rate,
              fetchedAt,
            },
          },
          {
            new: true,
            upsert: true,
            setDefaultsOnInsert: true,
          },
        )
        .lean()
        .exec();

      if (!savedRate) {
        throw new Error('Could not save the exchange rate');
      }

      return {
        rates: { [target]: savedRate.rate },
        fetchedAt: savedRate.fetchedAt.getTime(),
      };
    } catch {
      if (cached) {
        return cached;
      }

      throw new ServiceUnavailableException(
        'Exchange-rate provider unavailable and no cached rate exists',
      );
    }
  }

  private normalizeCurrency(value: string): string {
    const normalized = value.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(normalized)) {
      throw new BadRequestException(
        'Currency codes must be three-letter ISO-style codes',
      );
    }

    return normalized;
  }

  private buildLatestEndpoint(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);

      if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Unsupported provider protocol');
      }

      url.pathname = `${url.pathname.replace(/\/+$/, '')}/latest`;
      url.search = '';

      return url.toString();
    } catch {
      throw new ServiceUnavailableException(
        'Exchange-rate provider configuration is invalid',
      );
    }
  }
}