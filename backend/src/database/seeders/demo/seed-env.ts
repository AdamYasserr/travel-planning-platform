import { SEED_HOLD_MINUTES } from './demo-seed.constants';

/**
 * Imported FIRST by the seed command. The pending bookings of the seed keep their hold for two hours
 * instead of ten minutes (BOOKING_HOLD_MINUTES is read when the application code is loaded).
 */
process.env.BOOKING_HOLD_MINUTES = SEED_HOLD_MINUTES;
