import { PlatformCurrencyService } from './platform-currency.service';

describe('PlatformCurrencyService (PAY-04)', () => {
  const make = (code?: string) => new PlatformCurrencyService({ get: () => code } as never);

  it('defaults to USD', () => {
    expect(make(undefined).code).toBe('USD');
  });

  it('an omitted or empty currency means the platform currency', () => {
    expect(make('EGP').resolve(undefined)).toBe('EGP');
    expect(make('EGP').resolve(null)).toBe('EGP');
    expect(make('EGP').resolve('  ')).toBe('EGP');
  });

  it('accepts the platform currency in any case', () => {
    expect(make('EGP').resolve(' egp ')).toBe('EGP');
  });

  it('rejects any other currency with a 400 on the field, naming the platform currency', () => {
    try {
      make('USD').resolve('EUR');
      throw new Error('should have thrown');
    } catch (error) {
      const response = (error as { getResponse(): unknown; getStatus(): number });
      expect(response.getStatus()).toBe(400);
      expect(response.getResponse()).toMatchObject({ errors: [{ field: 'currency', messages: ['currency must be USD'] }] });
    }
  });
});
