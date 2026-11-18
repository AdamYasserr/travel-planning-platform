/** Currencies Stripe charges in whole units (no minor unit). */
export const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG',
  'RWF', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** Number of decimals of the minor unit: 0 for zero-decimal currencies, 2 otherwise. */
export function currencyExponent(currency: string): number {
  return ZERO_DECIMAL_CURRENCIES.has(currency.trim().toUpperCase()) ? 0 : 2;
}

/** A price in major units (e.g. 1350.5 EGP) as an integer number of minor units (135050). */
export function toMinor(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyExponent(currency));
}

/** Minor units back to the major-unit amount stored on bookings. */
export function fromMinor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}
