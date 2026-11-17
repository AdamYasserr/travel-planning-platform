export type PassengerType = 'adult' | 'child' | 'infant';

/**
 * Age group on the day of departure: under 2 is an infant, 2 to 11 a child, 12 or older an adult.
 * Age is counted in whole years by calendar date (UTC), so a passenger is 2 on their second birthday.
 */
export function passengerType(dateOfBirth: Date, departure: Date): PassengerType {
  let age = departure.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const beforeBirthday =
    departure.getUTCMonth() < dateOfBirth.getUTCMonth() ||
    (departure.getUTCMonth() === dateOfBirth.getUTCMonth() && departure.getUTCDate() < dateOfBirth.getUTCDate());
  if (beforeBirthday) age -= 1;
  if (age < 2) return 'infant';
  if (age < 12) return 'child';
  return 'adult';
}
