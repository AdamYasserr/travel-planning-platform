// Pure helpers for flight booking pricing, passenger age bands, refunds and
// CSV output. No database access, so they are easy to test.

import { PassengerType } from '../enums/flight-booking-status.enum';

// FLT-12(b): Infants pay 10% of the cabin fare
export const INFANT_FARE_RATE = 0.1;
export const ADULT_MIN_AGE = 12;
export const CHILD_MIN_AGE = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

export const round2 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

// Full years between a date of birth and a date (both YYYY-MM-DD).
export function ageOnDate(dateOfBirth: string, onDate: string): number {
  const [birthYear, birthMonth, birthDay] = dateOfBirth.split('-').map(Number);
  const [year, month, day] = onDate.split('-').map(Number);

  let age = year - birthYear;

  if (month < birthMonth || (month === birthMonth && day < birthDay)) {
    age -= 1;
  }

  return age;
}

// FLT-12(b): Adult 12+, Child 2-11, Infant under 2 (never trusted from client)
export function passengerTypeOnDate(
  dateOfBirth: string,
  onDate: string,
): PassengerType {
  const age = ageOnDate(dateOfBirth, onDate);

  if (age >= ADULT_MIN_AGE) return PassengerType.ADULT;
  if (age >= CHILD_MIN_AGE) return PassengerType.CHILD;
  return PassengerType.INFANT;
}

export interface PassengerCounts {
  adults: number;
  children: number;
  infants: number;
}

export interface FareLine {
  count: number;
  unitPrice: number;
  subtotal: number;
}

export interface SegmentFare {
  adults: FareLine;
  children: FareLine;
  infants: FareLine;
  // FLT-22: Infants take no seat
  seats: number;
  fareSubtotal: number;
}

// FLT-12(b): Adults and children pay the fare; infants pay 10% (2 decimals)
export function calculateSegmentFare(
  price: number,
  counts: PassengerCounts,
): SegmentFare {
  const infantFare = round2(price * INFANT_FARE_RATE);
  const adults = {
    count: counts.adults,
    unitPrice: price,
    subtotal: round2(price * counts.adults),
  };
  const children = {
    count: counts.children,
    unitPrice: price,
    subtotal: round2(price * counts.children),
  };
  const infants = {
    count: counts.infants,
    unitPrice: infantFare,
    subtotal: round2(infantFare * counts.infants),
  };

  return {
    adults,
    children,
    infants,
    seats: counts.adults + counts.children,
    fareSubtotal: round2(adults.subtotal + children.subtotal + infants.subtotal),
  };
}

// FLT-09 / FLT-26: floor((outbound departure - now) / 24h)
export function daysBeforeDeparture(departure: Date, now: Date): number {
  return Math.floor((departure.getTime() - now.getTime()) / DAY_MS);
}

export interface RefundTier {
  daysBeforeDeparture: number;
  refundPercentage: number;
}

// FLT-09: The tier with the HIGHEST daysBeforeDeparture that is <= the days
// remaining. If no tier applies, the refund is 0%.
export function selectRefundPercentage(
  tiers: readonly RefundTier[],
  daysRemaining: number,
): number {
  let selected: RefundTier | undefined;

  for (const tier of tiers) {
    if (
      tier.daysBeforeDeparture <= daysRemaining &&
      (!selected || tier.daysBeforeDeparture > selected.daysBeforeDeparture)
    ) {
      selected = tier;
    }
  }

  return selected?.refundPercentage ?? 0;
}

export interface RefundCalculation {
  daysBeforeDeparture: number;
  refundPercentage: number;
  refundAmount: number;
}

// FLT-26: Percentage of the full booking total, rounded to 2 decimals
export function calculateRefund(
  total: number,
  tiers: readonly RefundTier[],
  outboundDeparture: Date,
  now: Date,
): RefundCalculation {
  const days = daysBeforeDeparture(outboundDeparture, now);
  const refundPercentage = selectRefundPercentage(tiers, days);

  return {
    daysBeforeDeparture: days,
    refundPercentage,
    refundAmount: round2((total * refundPercentage) / 100),
  };
}

// FLT-29: CSV cell escaping. Cells starting with =, +, - or @ (and tab/CR,
// which spreadsheets also treat as formula starters) are prefixed with a
// single quote so they cannot run as formulas. Cells containing commas,
// quotes or line breaks are quoted.
export function escapeCsvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);

  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    text = `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n');
}
