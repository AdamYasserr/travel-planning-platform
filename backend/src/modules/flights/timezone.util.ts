import { BadRequestException } from '@nestjs/common';

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export function isValidIanaTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function parseFlightInstant(value: string, timeZone: string): Date {
  if (!isValidIanaTimeZone(timeZone)) {
    throw new BadRequestException(`Invalid airport IANA time zone: ${timeZone}`);
  }
  if (ISO_WITH_OFFSET.test(value)) {
    const instant = new Date(value);
    if (Number.isFinite(instant.getTime())) return instant;
  }
  const match = LOCAL_DATETIME.exec(value);
  if (!match) {
    throw new BadRequestException('Flight times must be ISO timestamps with an offset or airport-local date-times without an offset');
  }
  const [, y, mo, d, h, mi, sec = '0', millis = '0'] = match;
  const parts = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +sec, millisecond: +millis.padEnd(3, '0') };
  const wallTime = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
  const check = new Date(wallTime);
  if (check.getUTCFullYear() !== parts.year || check.getUTCMonth() !== parts.month - 1 || check.getUTCDate() !== parts.day || check.getUTCHours() !== parts.hour || check.getUTCMinutes() !== parts.minute || check.getUTCSeconds() !== parts.second) {
    throw new BadRequestException('Invalid local flight date-time');
  }
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 3) {
    const probe = new Date(wallTime + delta * 3600000);
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(probe).map(x => [x.type, x.value]));
    const localAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second, parts.millisecond);
    offsets.add(localAsUtc - probe.getTime());
  }
  const matches = [...offsets].map(offset => new Date(wallTime - offset)).filter(candidate => {
    const f = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(candidate).map(x => [x.type, x.value]));
    return +p.year === parts.year && +p.month === parts.month && +p.day === parts.day && +p.hour === parts.hour && +p.minute === parts.minute && +p.second === parts.second;
  }).sort((a,b)=>a.getTime()-b.getTime());
  if (!matches.length) throw new BadRequestException('Local flight time does not exist in the airport time zone because of a daylight-saving transition');
  if (matches.length > 1) throw new BadRequestException('Local flight time is ambiguous in the airport time zone; provide an explicit UTC offset');
  return matches[0];
}

// ---- UTC instant -> airport-local time (GEN-06) and local calendar days (FLT-11) ----

const formatters = new Map<string, Intl.DateTimeFormat>();
function wallClock(instant: Date, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, format);
  }
  const p = Object.fromEntries(format.formatToParts(instant).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second };
}

const two = (n: number) => String(n).padStart(2, '0');

export interface LocalInstant {
  /** Wall-clock time at the airport, YYYY-MM-DDTHH:mm:ss (no offset). */
  local: string;
  /** Offset of that wall-clock time from UTC at that instant, e.g. +02:00. */
  utcOffset: string;
  timeZone: string;
  /** The same instant in UTC (ISO 8601). */
  utc: string;
}

export function toLocalInstant(instant: Date, timeZone: string): LocalInstant {
  const w = wallClock(instant, timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const offsetMinutes = Math.round((wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return {
    local: `${w.year}-${two(w.month)}-${two(w.day)}T${two(w.hour)}:${two(w.minute)}:${two(w.second)}`,
    utcOffset: `${sign}${two(Math.floor(abs / 60))}:${two(abs % 60)}`,
    timeZone,
    utc: instant.toISOString(),
  };
}

/** The calendar date (YYYY-MM-DD) it currently is at `instant` in `timeZone`. */
export function localDateInZone(instant: Date, timeZone: string): string {
  const w = wallClock(instant, timeZone);
  return `${w.year}-${two(w.month)}-${two(w.day)}`;
}

/**
 * The UTC interval [start, end) covered by one local calendar day in `timeZone`. Handles days of 23 or 25 hours
 * (DST) and zones whose local midnight does not exist, by searching for the instant the local date changes.
 */
export function localDayRangeUtc(date: string, timeZone: string): { start: Date; end: Date } {
  const firstInstantOf = (day: string): Date => {
    const [y, m, d] = day.split('-').map(Number);
    const base = Date.UTC(y, m - 1, d);
    let lo = Math.floor((base - 15 * 3600_000) / 1000);
    let hi = Math.floor((base + 15 * 3600_000) / 1000);
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDateInZone(new Date(mid * 1000), timeZone) >= day) hi = mid;
      else lo = mid + 1;
    }
    return new Date(lo * 1000);
  };
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return { start: firstInstantOf(date), end: firstInstantOf(next) };
}
