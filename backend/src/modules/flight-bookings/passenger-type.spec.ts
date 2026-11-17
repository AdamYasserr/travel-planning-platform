import { passengerType } from './passenger-type';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const departure = new Date('2030-06-10T08:00:00.000Z');

describe('passenger type on the departure day', () => {
  it.each([
    ['2028-06-11', 'infant'], // 1 day before the 2nd birthday
    ['2028-06-10', 'child'], // 2nd birthday
    ['2018-06-11', 'child'], // 1 day before the 12th birthday
    ['2018-06-10', 'adult'], // 12th birthday
    ['1990-01-15', 'adult'],
    ['2030-01-01', 'infant'],
  ])('born %s is %s', (dob, expected) => {
    expect(passengerType(d(dob), departure)).toBe(expected);
  });
});
