import {
  classifyPassengers,
  countPassengers,
  infantFareMinor,
  passengerRuleErrors,
  priceSegment,
  seatsFor,
} from './booking-rules';

describe('flight booking rules (FLT-19, FLT-12)', () => {
  const departure = new Date('2027-06-15T08:00:00.000Z');
  const arrival = new Date('2027-06-15T12:00:00.000Z');
  const trip = { outboundDeparture: departure, lastArrival: arrival, now: new Date('2027-01-01T00:00:00.000Z') };
  const adult = { dateOfBirth: '1990-01-01', nationalId: '2900101' };
  const fieldsOf = (errors: { field: string }[]) => errors.map((e) => e.field);

  describe('passenger type from the date of birth on the outbound departure day', () => {
    it('is infant under 2, child from 2 to 11, adult from 12, by calendar birthday', () => {
      expect(classifyPassengers([
        { dateOfBirth: '2025-06-16' }, // 1 the day before the 2nd birthday
        { dateOfBirth: '2025-06-15' }, // 2 on the day
        { dateOfBirth: '2015-06-16' }, // 11
        { dateOfBirth: '2015-06-15' }, // 12 on the day
      ], departure)).toEqual(['infant', 'child', 'child', 'adult']);
    });

    it('counts seats as adults + children; infants take none', () => {
      const counts = countPassengers(['adult', 'adult', 'child', 'infant']);
      expect(counts).toEqual({ adults: 2, children: 1, infants: 1 });
      expect(seatsFor(counts)).toBe(3);
    });
  });

  describe('passenger rules', () => {
    it('accepts an adult with a national ID, and one with a passport valid after the last arrival', () => {
      expect(passengerRuleErrors([adult, { dateOfBirth: '1980-01-01', passportNumber: 'A1234567', passportExpiry: '2027-06-16' }], trip)).toEqual([]);
    });

    it('requires exactly one of passport or national ID', () => {
      expect(fieldsOf(passengerRuleErrors([{ dateOfBirth: '1990-01-01' }], trip))).toEqual(['passengers.0.passportNumber']);
      expect(fieldsOf(passengerRuleErrors([{ ...adult, passportNumber: 'A1234567', passportExpiry: '2030-01-01' }], trip))).toEqual(['passengers.0.nationalId']);
    });

    it('requires a passport expiry after the last arrival date, and only with a passport', () => {
      expect(fieldsOf(passengerRuleErrors([{ dateOfBirth: '1990-01-01', passportNumber: 'A1234567' }], trip))).toEqual(['passengers.0.passportExpiry']);
      expect(fieldsOf(passengerRuleErrors([{ dateOfBirth: '1990-01-01', passportNumber: 'A1234567', passportExpiry: '2027-06-15' }], trip))).toEqual(['passengers.0.passportExpiry']);
      expect(fieldsOf(passengerRuleErrors([{ ...adult, passportExpiry: '2030-01-01' }], trip))).toEqual(['passengers.0.passportExpiry']);
    });

    it('rejects a date of birth in the future', () => {
      expect(fieldsOf(passengerRuleErrors([adult, { dateOfBirth: '2027-02-01', nationalId: '1234' }], trip))).toEqual(['passengers.1.dateOfBirth']);
    });

    it('needs at least one adult, no more infants than adults, and at most 9 adults and children', () => {
      const child = { dateOfBirth: '2020-01-01', nationalId: '1234' };
      const infant = { dateOfBirth: '2026-01-01', nationalId: '1235' };
      expect(passengerRuleErrors([child], trip)).toEqual([{ field: 'passengers', messages: [expect.stringMatching(/adult/)] }]);
      expect(passengerRuleErrors([adult, infant, infant], trip)).toEqual([{ field: 'passengers', messages: [expect.stringMatching(/infant/)] }]);
      expect(passengerRuleErrors([adult, infant], trip)).toEqual([]);
      expect(passengerRuleErrors(Array(9).fill(adult), trip)).toEqual([]);
      expect(passengerRuleErrors([...Array(9).fill(adult), child], trip)).toEqual([{ field: 'passengers', messages: [expect.stringMatching(/9/)] }]);
      expect(passengerRuleErrors([...Array(9).fill(adult), infant], trip)).toEqual([]);
    });
  });

  describe('pricing in minor units', () => {
    it('an infant pays 10% of the fare, rounded half up', () => {
      expect(infantFareMinor(150000)).toBe(15000);
      expect(infantFareMinor(135050)).toBe(13505);
      expect(infantFareMinor(135055)).toBe(13506);
      expect(infantFareMinor(5)).toBe(1);
    });

    it('a segment costs seats x fare + infants x infant fare', () => {
      expect(priceSegment({ fareMinor: 150000, seats: 3, infants: 1 })).toEqual({
        fareMinor: 150000, seats: 3, infants: 1, seatFaresMinor: 450000, infantFaresMinor: 15000, subtotalMinor: 465000,
      });
      expect(priceSegment({ fareMinor: 135050, seats: 3, infants: 1 }).subtotalMinor).toBe(418655);
    });
  });
});
