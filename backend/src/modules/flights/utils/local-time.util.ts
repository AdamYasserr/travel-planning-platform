// GEN-06: Airport-local time helpers.
// Stored flight times are UTC; airports carry an IANA time zone.

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);

  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, formatter);
  }

  return formatter;
}

function getLocalParts(date: Date, timeZone: string): LocalParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

const pad = (value: number, length = 2) =>
  String(value).padStart(length, '0');

// UTC offset (in minutes) of a time zone at a given instant. Handles DST.
export function getUtcOffsetMinutes(date: Date, timeZone: string): number {
  const p = getLocalParts(date, timeZone);
  const wallClockAsUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  const instant = Math.floor(date.getTime() / 1000) * 1000;

  return Math.round((wallClockAsUtc - instant) / 60000);
}

// Local calendar date (YYYY-MM-DD) of an instant in a time zone.
export function getLocalDate(date: Date, timeZone: string): string {
  const p = getLocalParts(date, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

// e.g. 2026-11-09T11:00:00+02:00
export function formatLocalDateTime(date: Date, timeZone: string): string {
  const p = getLocalParts(date, timeZone);
  const offsetMinutes = getUtcOffsetMinutes(date, timeZone);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const offset = `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;

  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offset}`;
}

// First UTC instant whose local date in `timeZone` is `localDate` (YYYY-MM-DD).
function startOfLocalDay(localDate: string, timeZone: string): Date {
  const [year, month, day] = localDate.split('-').map(Number);
  const midnightAsUtc = Date.UTC(year, month - 1, day);

  // Two passes: the offset at "midnight treated as UTC" may differ from the
  // offset at the real local midnight when a DST change is near.
  const firstOffset = getUtcOffsetMinutes(new Date(midnightAsUtc), timeZone);
  const firstGuess = midnightAsUtc - firstOffset * 60000;
  const secondOffset = getUtcOffsetMinutes(new Date(firstGuess), timeZone);
  const secondGuess = midnightAsUtc - secondOffset * 60000;

  // Keep candidates that really fall on the requested local date and take the
  // earliest. This also covers zones where local midnight is skipped by DST.
  const candidates = [firstGuess, secondGuess].filter(
    (candidate) => getLocalDate(new Date(candidate), timeZone) === localDate,
  );

  return new Date(
    candidates.length > 0 ? Math.min(...candidates) : secondGuess,
  );
}

function nextCalendarDate(localDate: string): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return `${pad(next.getUTCFullYear(), 4)}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

// Converts a local calendar day at an airport into a UTC range [start, end).
// The day may be 23, 24 or 25 hours long on DST change days.
export function localDateToUtcRange(
  localDate: string,
  timeZone: string,
): { start: Date; end: Date } {
  return {
    start: startOfLocalDay(localDate, timeZone),
    end: startOfLocalDay(nextCalendarDate(localDate), timeZone),
  };
}
