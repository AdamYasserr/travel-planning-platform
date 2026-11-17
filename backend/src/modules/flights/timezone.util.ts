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
