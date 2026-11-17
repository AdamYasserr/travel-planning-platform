import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fieldErrors } from '../pipes/validation.pipe';

/** PAY-04: the single currency of every flight and hotel price and of every payment. */
@Injectable()
export class PlatformCurrencyService {
  constructor(private readonly config: ConfigService) {}

  get code(): string {
    return (this.config.get<string>('platform.currency') || 'USD').trim().toUpperCase();
  }

  /**
   * An omitted currency means the platform currency. A different explicit currency is rejected
   * with a 400 on the given field, naming the platform currency.
   */
  resolve(value: string | undefined | null, field = 'currency'): string {
    if (value === undefined || value === null || String(value).trim() === '') return this.code;
    const normalized = String(value).trim().toUpperCase();
    if (normalized !== this.code) {
      throw fieldErrors([{ field, messages: [`${field} must be ${this.code}`] }]);
    }
    return normalized;
  }
}
