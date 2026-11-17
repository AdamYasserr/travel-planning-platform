# Stripe booking payments

## Design and database requirements

Payments are created only for an authenticated user's pending booking. The API
reads the booking's saved total and currency, creates one Payment record per
booking, and uses that record's ID as Stripe's Checkout and refund idempotency
key. The client never supplies a charge amount.

Stripe signs webhook deliveries. Nest preserves the original request bytes and
the webhook verifies the `Stripe-Signature` header before processing. Webhook
event IDs are unique, and a MongoDB transaction records each event alongside
the associated payment and booking state transition.

Transactions require a MongoDB replica set or sharded deployment. The configured
development database was checked and reported replica-set transaction support.
Standalone MongoDB deployments are not supported for payment confirmation,
expiration, or cancellation.

Hotel and flight booking holds remain 15 minutes. Stripe Checkout sessions have
a 30-minute minimum expiry, so the backend expires the session when the booking
hold expires. A late successful payment never confirms an expired/cancelled
booking; the webhook requests an idempotent refund instead. See Stripe's
[Checkout Session expiry rules](https://docs.stripe.com/api/checkout/sessions/create#checkout_session_create-expires_at).

Hotel cancellation refunds use the cancellation tiers saved on the booking.
Flight cancellation refunds use the airline policy tiers saved when the booking
was created. A confirmed flight booking without a saved policy cannot be
cancelled through the customer booking endpoint. Pending unpaid flight holds
can be cancelled and release their seats.

## Room currency

Hotel room rates now require an ISO 4217 currency. New room creation must send
`currency`, and managers can set it on existing rooms with the room update
endpoint. Existing room records without a currency remain unpayable until that
field is set. Each hotel booking stores a currency snapshot. A reservation with
rooms priced in different currencies is rejected because one Checkout Session
has one currency.

Stripe expects amounts in minor units; the backend converts the server-stored
booking amount using the currency's Stripe minor-unit rules. See Stripe's
[supported currency and amount rules](https://docs.stripe.com/currencies).

## Configuration

Set these variables in the backend environment. Keep secret values out of
source control and use test-mode credentials during initial setup:

```dotenv
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_CHECKOUT_SUCCESS_URL=http://localhost:3001/payment/success
STRIPE_CHECKOUT_CANCEL_URL=http://localhost:3001/payment/cancel
```

When either Stripe key is configured, all four variables are required. The
secret key must use the `sk_test_` prefix. The success URL is only a browser
return destination; returning there does not confirm a booking. The client must
read payment or booking status from the API.

For local webhook testing, install Stripe CLI and run:

```sh
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Copy the signing secret printed by the CLI to `STRIPE_WEBHOOK_SECRET`. In
Stripe Workbench, add an HTTPS webhook endpoint at `/api/stripe/webhook` and
subscribe to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `payment_intent.payment_failed`
- `refund.updated`

Stripe's [webhook setup guide](https://docs.stripe.com/webhooks) describes
endpoint registration and local testing.

## API

All customer endpoints require the authenticated access cookie. The payment
request contains only the booking kind and booking ID; amount and currency are
loaded from the saved booking.

Create a hotel or flight Checkout Session:

```http
POST /api/payments/checkout-session
Content-Type: application/json
```

```json
{
  "bookingType": "hotel",
  "bookingId": "507f1f77bcf86cd799439011"
}
```

Use `"bookingType": "flight"` for a flight booking. A successful response
contains:

```json
{
  "paymentId": "507f1f77bcf86cd799439022",
  "checkoutSessionId": "cs_test_...",
  "checkoutUrl": "https://checkout.stripe.com/...",
  "amountMinor": 20000,
  "currency": "egp",
  "holdExpiresAt": "2026-11-14T20:30:00.000Z",
  "status": "Pending"
}
```

Read the current payment state after the browser returns:

```http
GET /api/payments/507f1f77bcf86cd799439022
```

The signed webhook is `POST /api/stripe/webhook`. It is public to Stripe but
rejects requests without a valid signature and original request body. Do not
call it from a client.

Cancel a booking using its existing endpoint:

```http
DELETE /api/hotel-bookings/507f1f77bcf86cd799439011
DELETE /api/flight-bookings/507f1f77bcf86cd799439011
```

Hotel cancellation responses include the policy refund percentage and refund
status. A refund can remain pending or fail after the booking has been
cancelled; inspect the returned state or `GET /api/payments/:id` before taking
further action. Flight cancellations use only the saved airline tier snapshot.

## Booking setup examples

Create a hotel room with its rate currency:

```json
{
  "name": "Deluxe 402",
  "type": "Deluxe double",
  "beds": 2,
  "maxOccupancy": 3,
  "pricePerNight": 125.5,
  "currency": "EGP"
}
```

Create a hotel hold:

```json
{
  "hotelId": "507f1f77bcf86cd799439011",
  "checkInDate": "2026-12-01",
  "checkOutDate": "2026-12-04",
  "rooms": [
    {
      "roomId": "507f1f77bcf86cd799439012",
      "adults": 2,
      "childrenAges": [8]
    }
  ],
  "policiesAccepted": true
}
```

Create a flight hold:

```json
{
  "flightId": "507f1f77bcf86cd799439013",
  "cabinClass": "Economy",
  "passengers": [
    {
      "fullName": "Taylor Passenger",
      "dateOfBirth": "1990-01-15"
    }
  ],
  "policiesAccepted": true
}
```
