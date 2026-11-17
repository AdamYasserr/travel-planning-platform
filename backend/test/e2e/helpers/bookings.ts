import type { E2EContext } from './app';
import { StripeFake } from './fakes';
import { day, type TestUser } from './factories';

export type BookingType = 'hotel' | 'flight';

export function holdHotel(
  user: TestUser,
  input: { hotelId: string; roomIds: string[]; checkIn?: string; checkOut?: string; adults?: number; body?: Record<string, unknown> },
) {
  return user.agent.post('/api/hotel-bookings').send({
    hotelId: input.hotelId,
    checkInDate: input.checkIn ?? day(10),
    checkOutDate: input.checkOut ?? day(13),
    rooms: input.roomIds.map((roomId) => ({ roomId, adults: input.adults ?? 1, childrenAges: [] })),
    policiesAccepted: true,
    ...input.body,
  });
}

export function holdFlight(user: TestUser, input: { flightId: string; passengers?: number; cabinClass?: string; body?: Record<string, unknown> }) {
  return user.agent.post('/api/flight-bookings').send({
    flightId: input.flightId,
    cabinClass: input.cabinClass ?? 'Economy',
    passengers: Array.from({ length: input.passengers ?? 1 }, (_, i) => ({ fullName: `Passenger ${i + 1}`, dateOfBirth: '1990-01-01' })),
    policiesAccepted: true,
    ...input.body,
  });
}

/**
 * Turns a Pending Payment hold into a Confirmed booking through the REAL payment path:
 * the user opens a payment, then the (signature-checked) Stripe webhook reports success.
 * ALL Stripe specifics live here and in StripeFake, so tests never mention Stripe events.
 * Returns the payment id (also the refund id, see GET /refunds/:id).
 */
export async function confirmBooking(ctx: E2EContext, user: TestUser, type: BookingType, bookingId: string): Promise<string> {
  const pay = await user.agent.post('/api/payments/checkout-session').send({ bookingType: type, bookingId });
  if (pay.status >= 300) throw new Error(`could not start payment: ${pay.status} ${JSON.stringify(pay.body)}`);
  const event = ctx.stripe.successEvent({
    paymentId: String(pay.body.paymentId),
    checkoutSessionId: pay.body.checkoutSessionId,
    bookingType: type,
    bookingId,
    userId: user.id,
    amountMinor: pay.body.amountMinor,
    currency: pay.body.currency,
  });
  const hook = await ctx.http().post('/api/payments/webhook').set('stripe-signature', StripeFake.VALID_SIGNATURE).set('content-type', 'application/json').send(JSON.stringify(event));
  if (hook.status !== 201) throw new Error(`webhook failed: ${hook.status} ${JSON.stringify(hook.body)}`);
  return String(pay.body.paymentId);
}

/** Starts a payment only (booking stays Pending Payment). */
export async function startPayment(user: TestUser, type: BookingType, bookingId: string) {
  return user.agent.post('/api/payments/checkout-session').send({ bookingType: type, bookingId });
}
