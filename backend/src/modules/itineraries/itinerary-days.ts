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

/** A YYYY-MM-DD date plus `days` days (UTC). */
export function addDaysToIso(date: string, days: number): string {
  return isoDay(new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS));
}

export interface GroupChoice {
  /** The 1-based number of the group (its place in the city groups). */
  index: number;
  group: CityGroup;
}

/**
 * ITN-25 / ITN-26: which city group a search is about. `group` is the 1-based number of the group,
 * `city` a city_id (its FIRST group); both must agree; neither means the first group.
 * Returns an error as { field, message } instead of a group when the choice is not possible.
 */
export function pickCityGroup(
  groups: CityGroup[],
  choice: { group?: number; city?: string },
): GroupChoice | { field: string; message: string } {
  if (!groups.length) return { field: 'itinerary', message: 'Add at least one day with a city to this itinerary first' };
  let index = 1;
  if (choice.group !== undefined) {
    if (choice.group < 1 || choice.group > groups.length) {
      return { field: 'group', message: `group must be between 1 and ${groups.length} (this itinerary has ${groups.length} city group(s))` };
    }
    index = choice.group;
    if (choice.city !== undefined && groups[index - 1].cityId !== choice.city) {
      return { field: 'city', message: `Group ${index} is in ${groups[index - 1].cityId}, not ${choice.city}` };
    }
  } else if (choice.city !== undefined) {
    const found = groups.findIndex((g) => g.cityId === choice.city);
    if (found < 0) {
      return { field: 'city', message: `city must be one of the itinerary's cities (${[...new Set(groups.map((g) => g.cityId))].join(', ')})` };
    }
    index = found + 1;
  }
  return { index, group: groups[index - 1] };
}
