import { BadRequestException } from '@nestjs/common';
import { isValidIanaTimeZone, parseFlightInstant } from './timezone.util';

describe('flight timezone conversion', () => {
  it('converts airport-local wall time to the correct UTC instant', () => {
    expect(parseFlightInstant('2026-01-15T12:00:00', 'Africa/Cairo').toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });
  it('preserves an explicit UTC offset independent of airport zone', () => {
    expect(parseFlightInstant('2026-07-15T12:00:00+02:00', 'America/New_York').toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });
  it('rejects nonexistent spring-forward local times', () => {
    expect(() => parseFlightInstant('2026-03-08T02:30:00', 'America/New_York')).toThrow(BadRequestException);
  });
  it('rejects ambiguous fall-back local times unless an offset is supplied', () => {
    expect(() => parseFlightInstant('2026-11-01T01:30:00', 'America/New_York')).toThrow(/ambiguous/);
    expect(parseFlightInstant('2026-11-01T01:30:00-04:00', 'America/New_York').toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });
  it('rejects invalid time zones and invalid calendar dates', () => {
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
    expect(() => parseFlightInstant('2026-02-30T12:00:00', 'Etc/UTC')).toThrow(BadRequestException);
    expect(() => parseFlightInstant('2026-01-01T12:00:00', 'Not/AZone')).toThrow(BadRequestException);
  });
});
