import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

interface ProviderResponse {
  rates?: Record<string, number>;
}

interface CachedRates {
  rates: Record<string, number>;
  fetchedAt: number;
}

@Injectable()
export class FxRatesService {
  private readonly cache = new Map<string, CachedRates>();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
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
      stale: Date.now() - rates.fetchedAt >
        this.getNumberConfig('fxRates.staleTtlMs', 86400000),
      fetchedAt: new Date(rates.fetchedAt).toISOString(),
    };
  }

  async convert(amount: number, from: string, to: string) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestException(
        'Conversion amount must be a finite positive number',
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

  private async getRates(base: string, target: string): Promise<CachedRates> {
    const key = `${base}:${target}`;
    const cached = this.cache.get(key);
    const now = Date.now();
    const cacheTtl = this.getNumberConfig('fxRates.cacheTtlMs', 900000);

    if (cached && now - cached.fetchedAt <= cacheTtl) {
      return cached;
    }

    try {
      const baseUrl = this.configService.getOrThrow<string>('fxRates.baseUrl');
      const apiKey = this.configService.get<string>('fxRates.apiKey');
      const endpoint = this.buildLatestEndpoint(baseUrl);
      const response = await firstValueFrom(
        this.httpService.get<ProviderResponse>(
          endpoint,
          {
            timeout: 5000,
            params: {
              base,
              symbols: target,
              ...(apiKey ? { apikey: apiKey } : {}),
            },
          },
        ),
      );

      const rates = response.data?.rates;
      if (
        !rates ||
        typeof rates !== 'object' ||
        Array.isArray(rates) ||
        typeof rates[target] !== 'number' ||
        !Number.isFinite(rates[target]) ||
        rates[target] <= 0
      ) {
        throw new Error('Provider response did not contain the requested rate');
      }

      const fresh: CachedRates = { rates, fetchedAt: now };
      this.cache.set(key, fresh);
      return fresh;
    } catch (error: unknown) {
      const staleTtl = this.getNumberConfig(
        'fxRates.staleTtlMs',
        86400000,
      );
      if (cached && now - cached.fetchedAt <= staleTtl) {
        return cached;
      }

      throw new ServiceUnavailableException(
        'Exchange-rate provider unavailable',
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

  private getNumberConfig(path: string, fallback: number): number {
    const value = this.configService.get<number>(path);
    return typeof value === 'number' && value > 0 ? value : fallback;
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