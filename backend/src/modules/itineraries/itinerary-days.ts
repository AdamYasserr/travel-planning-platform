const DAY_MS = 86_400_000;

/** The UTC calendar day of a stored date, as YYYY-MM-DD. */
export const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * ITN-05: a day has no stored date. It is DERIVED from the itinerary's start date and the day's position:
 * startDate + (dayNumber - 1) days (UTC calendar days). Adding, deleting or reordering days and editing the
 * start date therefore keep dates, numbering and city groups consistent without any extra write.
 */
export function dayDate(startDate: Date, dayNumber: number): string {
  const start = Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  return isoDay(new Date(start + (dayNumber - 1) * DAY_MS));
}

export interface CityGroup {
  cityId: string;
  /** First and last date of the run (YYYY-MM-DD, derived). */
  startDate: string;
  endDate: string;
  dayCount: number;
  dayIds: string[];
}

/**
 * ITN-09: consecutive days in the same city form one group, in day order. A city that is left and visited
 * again (Cairo, Alexandria, Cairo) gives two groups. Computed on read; never a validation rule.
 */
export function cityGroups(
  days: { _id?: { toString(): string }; dayNumber: number; cityId: string }[],
  startDate: Date,
): CityGroup[] {
  const groups: CityGroup[] = [];
  for (const day of days) {
    const last = groups[groups.length - 1];
    const date = dayDate(startDate, day.dayNumber);
    if (last && last.cityId === day.cityId) {
      last.endDate = date;
      last.dayCount += 1;
      last.dayIds.push(String(day._id));
    } else {
      groups.push({ cityId: day.cityId, startDate: date, endDate: date, dayCount: 1, dayIds: [String(day._id)] });
    }
  }
  return groups;
}
