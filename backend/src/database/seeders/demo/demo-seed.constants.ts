/** Everything that identifies the demo data. One place, so --reset and the docs agree. */

/** Version of the marker. The manifest of an older version is not touched by this one. */
export const SEED_TAG = 'demo-seed-v1';

export const SEED_USERS = {
  admin: { name: 'Demo Admin', email: 'admin@demo-seed.test', role: 'admin' },
  sara: { name: 'Sara Demo', email: 'sara@demo-seed.test', role: 'user' },
  omar: { name: 'Omar Demo', email: 'omar@demo-seed.test', role: 'user' },
  airlineModerator: { name: 'Demo Airline Moderator', email: 'airline-mod@demo-seed.test', role: 'moderator' },
  hotelModerator: { name: 'Demo Hotel Moderator', email: 'hotel-mod@demo-seed.test', role: 'moderator' },
} as const;

export type SeedUserKey = keyof typeof SEED_USERS;

export const SEED_AIRLINE = { name: 'Demo Seed Air', code: 'DSA' } as const;

export const SEED_FLIGHT_NUMBERS = { outbound: 'DSA101', return: 'DSA102', oneWay: 'DSA201' } as const;

export const SEED_HOTEL_NAME = 'Demo Seed Hotel';

/** The hold of the pending bookings lasts this long (the app default is 10 minutes), so manual tests have time. */
export const SEED_HOLD_MINUTES = '120';
