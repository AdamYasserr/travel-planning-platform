import type { FieldError } from '../../common/pipes/validation.pipe';
import { passengerType, type PassengerType } from './passenger-type';

/** FLT-19: at most this many passengers with a seat (adults + children) per booking, as in flight search. */
export const MAX_SEATED_PASSENGERS = 9;
/** FLT-12(b): an infant pays this share (in percent) of the cabin fare and takes no seat. */
export const INFANT_FARE_PERCENT = 10;

export interface PassengerDetails {
  dateOfBirth: string;
  passportNumber?: string;
  passportExpiry?: string;
  nationalId?: string;
}

export interface PassengerCounts {
  adults: number;
  children: number;
  infants: number;
}

const utcDate = (value: string) => new Date(`${value}T00:00:00.000Z`);
const isoDay = (value: Date) => value.toISOString().slice(0, 10);

/** The type of each passenger, from the date of birth on the day of the OUTBOUND departure. */
export function classifyPassengers(passengers: { dateOfBirth: string }[], outboundDeparture: Date): PassengerType[] {
  return passengers.map((p) => passengerType(utcDate(p.dateOfBirth), outboundDeparture));
}

export function countPassengers(types: PassengerType[]): PassengerCounts {
  return {
    adults: types.filter((t) => t === 'adult').length,
    children: types.filter((t) => t === 'child').length,
    infants: types.filter((t) => t === 'infant').length,
  };
}

/** Adults and children take a seat; infants travel on an adult's lap. */
export const seatsFor = (counts: PassengerCounts) => counts.adults + counts.children;

/**
 * Every passenger rule that needs the trip's dates, as field errors (empty when the passengers are valid):
 * date of birth in the past; exactly one of passport or national ID; a passport needs an expiry date after
 * the LAST segment's arrival (UTC date); at least one adult; no more infants than adults; at most
 * MAX_SEATED_PASSENGERS adults and children.
 */
export function passengerRuleErrors(
  passengers: PassengerDetails[],
  trip: { outboundDeparture: Date; lastArrival: Date; now: Date },
): FieldError[] {
  const errors: FieldError[] = [];
  const add = (field: string, message: string) => errors.push({ field, messages: [message] });

  passengers.forEach((p, i) => {
    const at = `passengers.${i}`;
    const born = utcDate(p.dateOfBirth);
    if (born > trip.now || born > trip.outboundDeparture) add(`${at}.dateOfBirth`, 'dateOfBirth must be in the past');

    const hasPassport = p.passportNumber !== undefined;
    const hasNationalId = p.nationalId !== undefined;
    if (hasPassport && hasNationalId) {
      add(`${at}.nationalId`, 'Send either passportNumber or nationalId, not both');
    } else if (!hasPassport && !hasNationalId) {
      add(`${at}.passportNumber`, 'passportNumber or nationalId is required');
    }

    if (hasPassport && p.passportExpiry === undefined) {
      add(`${at}.passportExpiry`, 'passportExpiry is required with passportNumber');
    } else if (!hasPassport && p.passportExpiry !== undefined) {
      add(`${at}.passportExpiry`, 'passportExpiry is only allowed with passportNumber');
    } else if (hasPassport && p.passportExpiry! <= isoDay(trip.lastArrival)) {
      add(`${at}.passportExpiry`, `passportExpiry must be after the arrival of the last flight (${isoDay(trip.lastArrival)})`);
    }
  });

  const counts = countPassengers(classifyPassengers(passengers, trip.outboundDeparture));
  if (counts.adults === 0) add('passengers', 'At least one adult (12 or older on the departure date) is required');
  if (counts.infants > counts.adults) add('passengers', 'Each infant needs an adult: infants must not exceed adults');
  if (seatsFor(counts) > MAX_SEATED_PASSENGERS) {
    add('passengers', `At most ${MAX_SEATED_PASSENGERS} adults and children per booking`);
  }
  return errors;
}

/** An infant's fare in minor units: INFANT_FARE_PERCENT of the cabin fare, rounded half up per infant. */
export function infantFareMinor(fareMinor: number): number {
  return Math.round((fareMinor * INFANT_FARE_PERCENT) / 100);
}

export interface SegmentPrice {
  fareMinor: number;
  seats: number;
  infants: number;
  seatFaresMinor: number;
  infantFaresMinor: number;
  extraBags: number;
  bagFeeMinor: number;
  extraBagsFeeMinor: number;
  subtotalMinor: number;
}

/**
 * One flight's share of the total, in minor units:
 * seats x fare + infants x infant fare + extra bags x fee per extra bag (free bags cost nothing).
 */
export function priceSegment(input: { fareMinor: number; seats: number; infants: number; extraBags?: number; bagFeeMinor?: number }): SegmentPrice {
  const extraBags = input.extraBags ?? 0;
  const bagFeeMinor = extraBags > 0 ? (input.bagFeeMinor ?? 0) : 0;
  const seatFaresMinor = input.seats * input.fareMinor;
  const infantFaresMinor = input.infants * infantFareMinor(input.fareMinor);
  const extraBagsFeeMinor = extraBags * bagFeeMinor;
  return {
    fareMinor: input.fareMinor,
    seats: input.seats,
    infants: input.infants,
    seatFaresMinor,
    infantFaresMinor,
    extraBags,
    bagFeeMinor,
    extraBagsFeeMinor,
    subtotalMinor: seatFaresMinor + infantFaresMinor + extraBagsFeeMinor,
  };
}

export type Direction = 'outbound' | 'return';

/** What the extra-bag rules need to know about the airline's baggage policy of one flight. */
export interface BaggageTerms {
  maxExtraBagsPerPassenger: number;
  currency: string;
}

/**
 * FLT-08: the extra bags asked for on one flight. Over the airline's maximum per passenger: 400 errors.
 * Bags asked for but impossible to charge (no baggage policy, or a policy priced in another currency than
 * the platform's): a 409 conflict, so currencies are never mixed. No bags asked for: never an error.
 */
export function extraBagRules(
  passengers: { extraBags?: Partial<Record<Direction, number>> }[],
  direction: Direction,
  policy: BaggageTerms | null,
  platformCurrency: string,
): { total: number; errors: FieldError[]; conflict: { field: string; message: string } | null } {
  const errors: FieldError[] = [];
  let total = 0;
  let first: string | null = null;
  passengers.forEach((p, i) => {
    const bags = p.extraBags?.[direction] ?? 0;
    if (bags <= 0) return;
    const field = `passengers.${i}.extraBags.${direction}`;
    first ??= field;
    total += bags;
    if (policy && bags > policy.maxExtraBagsPerPassenger) {
      errors.push({ field, messages: [`At most ${policy.maxExtraBagsPerPassenger} extra bag(s) per passenger on the ${direction} flight`] });
    }
  });
  let conflict: { field: string; message: string } | null = null;
  if (first && !policy) {
    conflict = { field: first, message: `The airline of the ${direction} flight has no baggage policy, so extra bags cannot be booked` };
  } else if (first && policy && policy.currency.trim().toUpperCase() !== platformCurrency) {
    conflict = {
      field: first,
      message: `Extra bags on the ${direction} flight cannot be booked: the airline prices them in ${policy.currency.toUpperCase()}, not the platform currency ${platformCurrency}`,
    };
  }
  return { total, errors, conflict };
}
