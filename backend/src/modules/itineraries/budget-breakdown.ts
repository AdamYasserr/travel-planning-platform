import { BudgetCategory, BudgetEntryType } from './schemas/budget.schema';

/** The five budget buckets: the four entry categories plus the itinerary's intercity transport costs. */
export const BREAKDOWN_BUCKETS = [
  BudgetCategory.FOOD,
  BudgetCategory.ACCOMMODATION,
  BudgetCategory.IN_CITY_TRANSPORT,
  BudgetCategory.ACTIVITIES,
  'intercity_transport',
] as const;
export type BreakdownBucket = (typeof BREAKDOWN_BUCKETS)[number];

export interface PlannedActual {
  planned: number;
  actual: number;
}

export type Breakdown = Record<BreakdownBucket, PlannedActual>;

const round2 = (value: number) => Number(value.toFixed(2));

/**
 * ITN-14 / ITN-18: planned and actual totals per bucket, and the grand total. Every amount is already
 * converted into the display currency. Intercity transport costs have no planned/actual type: they are
 * planned (as in the existing plannedTotal), so their actual is 0.
 */
export function buildBreakdown(
  entries: { category: BudgetCategory; type: BudgetEntryType; converted: number }[],
  transportCosts: { converted: number }[],
): { breakdown: Breakdown; grandTotal: PlannedActual } {
  const sums = Object.fromEntries(BREAKDOWN_BUCKETS.map((bucket) => [bucket, { planned: 0, actual: 0 }])) as Breakdown;
  const total = { planned: 0, actual: 0 };
  for (const entry of entries) {
    const side = entry.type === BudgetEntryType.ACTUAL ? 'actual' : 'planned';
    total[side] += entry.converted; // also entries of a category this version does not know (legacy data)
    if (sums[entry.category]) sums[entry.category][side] += entry.converted;
  }
  for (const cost of transportCosts) {
    sums.intercity_transport.planned += cost.converted;
    total.planned += cost.converted;
  }

  const breakdown = Object.fromEntries(
    BREAKDOWN_BUCKETS.map((bucket) => [bucket, { planned: round2(sums[bucket].planned), actual: round2(sums[bucket].actual) }]),
  ) as Breakdown;
  const grandTotal = { planned: round2(total.planned), actual: round2(total.actual) };
  return { breakdown, grandTotal };
}

export interface RateUsed {
  from: string;
  to: string;
  rate: number;
  fetchedAt: string | null;
  stale: boolean;
}

/** The oldest rate date used, so the summary says how old its least fresh rate is. Null: nothing was converted. */
export function ratesAsOf(rates: RateUsed[]): string | null {
  const dates = rates.map((rate) => rate.fetchedAt).filter((value): value is string => !!value);
  return dates.length ? dates.reduce((oldest, value) => (value < oldest ? value : oldest)) : null;
}
