import { buildBreakdown, ratesAsOf } from './budget-breakdown';
import { BudgetCategory, BudgetEntryType } from './schemas/budget.schema';

describe('budget breakdown (ITN-14, ITN-18)', () => {
  const entry = (category: BudgetCategory, type: BudgetEntryType, converted: number) => ({ category, type, converted });

  it('sums planned and actual per bucket; intercity transport is planned; the grand total adds every bucket', () => {
    const { breakdown, grandTotal } = buildBreakdown(
      [
        entry(BudgetCategory.FOOD, BudgetEntryType.PLANNED, 10.1),
        entry(BudgetCategory.FOOD, BudgetEntryType.PLANNED, 20.2),
        entry(BudgetCategory.FOOD, BudgetEntryType.ACTUAL, 5),
        entry(BudgetCategory.ACCOMMODATION, BudgetEntryType.PLANNED, 100),
        entry(BudgetCategory.IN_CITY_TRANSPORT, BudgetEntryType.ACTUAL, 7.25),
        entry(BudgetCategory.ACTIVITIES, BudgetEntryType.PLANNED, 40),
      ],
      [{ converted: 50 }, { converted: 0.55 }],
    );
    expect(breakdown).toEqual({
      food: { planned: 30.3, actual: 5 },
      accommodation: { planned: 100, actual: 0 },
      in_city_transport: { planned: 0, actual: 7.25 },
      activities: { planned: 40, actual: 0 },
      intercity_transport: { planned: 50.55, actual: 0 },
    });
    expect(grandTotal).toEqual({ planned: 220.85, actual: 12.25 });
  });

  it('an empty itinerary is all zeros', () => {
    const { breakdown, grandTotal } = buildBreakdown([], []);
    expect(Object.values(breakdown).every((b) => b.planned === 0 && b.actual === 0)).toBe(true);
    expect(grandTotal).toEqual({ planned: 0, actual: 0 });
  });

  it('ratesAsOf is the oldest rate date, or null when nothing was converted', () => {
    const rate = (fetchedAt: string | null) => ({ from: 'EUR', to: 'USD', rate: 1.1, fetchedAt, stale: false });
    expect(ratesAsOf([])).toBeNull();
    expect(ratesAsOf([rate(null)])).toBeNull();
    expect(ratesAsOf([rate('2026-11-18T10:00:00.000Z'), rate('2026-11-17T09:00:00.000Z'), rate(null)])).toBe('2026-11-17T09:00:00.000Z');
  });
});
