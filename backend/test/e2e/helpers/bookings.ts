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
    passengers: Array.from({ length: input.passengers ?? 1 }, (_, i) => ({ fullName: `Passenger ${i + 1}`, dateOfBirth: '1990-01-01', passportNumber: `P${1000000 + i}`, passportExpiry: '2045-01-01', nationality: 'EG' })),
    policiesAccepted: true,
    ...input.body,
  });
}

/** Delivers a (fake) Stripe event to the REAL webhook route with a valid signature. */
export function sendWebhook(ctx: E2EContext, event: unknown, signature: string = StripeFake.VALID_SIGNATURE) {
  return ctx.http().post('/api/payments/webhook').set('stripe-signature', signature).set('content-type', 'application/json').send(JSON.stringify(event));
}

export function acceptPolicies(user: TestUser, type: BookingType, bookingId: string) {
  return user.agent.post(`/api/bookings/${type}/${bookingId}/accept-policies`).send({ accepted: true });
}

/** Starts a payment only (booking stays Pending Payment): POST /api/payments. */
export async function startPayment(user: TestUser, type: BookingType, bookingId: string) {
  return user.agent.post('/api/payments').send({ bookingType: type, bookingId });
}

/** The PaymentIntent id behind a POST /api/payments (or retry) response. */
export function intentIdOf(ctx: E2EContext, paymentBody: { clientSecret: string }): string {
  return ctx.stripe.intentIdFromSecret(paymentBody.clientSecret);
}

/**
 * Turns a Pending Payment hold into a Confirmed booking through the REAL payment path:
 * the user accepts the policies, opens a payment (PaymentIntent), then the (signature-checked) Stripe
 * webhook reports success. ALL Stripe specifics live here and in StripeFake, so tests never mention
 * Stripe events. Returns the payment id (also the refund id, see GET /refunds/:id).
 */
export async function confirmBooking(ctx: E2EContext, user: TestUser, type: BookingType, bookingId: string): Promise<string> {
  const accepted = await acceptPolicies(user, type, bookingId);
  if (accepted.status >= 300) throw new Error(`could not accept policies: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  const pay = await startPayment(user, type, bookingId);
  if (pay.status >= 300) throw new Error(`could not start payment: ${pay.status} ${JSON.stringify(pay.body)}`);
  const hook = await sendWebhook(ctx, ctx.stripe.succeededEvent(intentIdOf(ctx, pay.body)));
  if (hook.status !== 201) throw new Error(`webhook failed: ${hook.status} ${JSON.stringify(hook.body)}`);
  return String(pay.body.paymentId);
}
