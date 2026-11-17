# Travel Planning & Booking Platform — Backend

## 1. Project Overview

The backend of the Travel Planning & Booking Platform, developed as part of Software Project I at the German International University.

The backend provides REST APIs for authentication, account management, travel planning, bookings, payments, and community features.

## 2. Technology Stack

- **Framework:** NestJS
- **Language:** TypeScript
- **Database:** MongoDB Atlas
- **ODM:** Mongoose (confirm against the installed dependencies)
- **API Documentation:** Swagger
- **Authentication:** JWT with HttpOnly cookies

## 3. Project Structure

```text
backend/
├── src/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   └── media/
│   ├── common/
│   ├── config/
│   └── main.ts
├── docs/
├── test/
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

*Update this structure to match the actual repository.*

## 4. Prerequisites

- Node.js
- npm
- MongoDB Atlas account
- Git

## 5. Installation

Clone the repository:

```bash
git clone <repository-url>
cd travel-planning-platform/backend
```

Install dependencies:

```bash
npm install
```

## 6. Environment Configuration

Create a `.env` file in the backend directory using `.env.example` as a reference.

Configure the required environment variables, including:

- MongoDB connection string
- JWT configuration
- Cookie configuration
- Other required external service credentials
- `PLATFORM_CURRENCY` (default `USD`): the one currency of every room rate, cabin fare and payment (PAY-04)

Never commit `.env` or expose credentials in the repository.

## 7. Running the Backend

Development:

```bash
npm run start:dev
```

Production build:

```bash
npm run build
```

Production:

```bash
npm run start:prod
```

### Reference data import (GEN-12)

Countries, cities, airports and attractions come from the official CSV datasets in
`backend/data/reference/` (`Countries.csv`, `Cities.csv`, `Airports.csv`, `Attractions.csv`).
Import them once after configuring `MONGODB_URI` in `.env`, and again whenever the files change:

```bash
cd backend
npm run seed:reference                 # reads data/reference
npm run seed:reference -- ./other-dir  # or a custom folder (also: REFERENCE_DATA_DIR=...)
```

- Required headers: `code,name,currency` / `city_id,name,country_code` /
  `iata_code,name,city_id,country_code,time_zone` / `attraction_id,name,city_id`.
  A missing column aborts the import and names the file and column.
- Invalid rows (empty IDs, unknown country/city, city/country mismatch, bad IANA `time_zone`,
  non-3-letter currency, duplicate IDs) are skipped and reported as `File.csv:<line>`.
- Safe to re-run: records are upserted by dataset ID, in the order countries, cities, airports,
  attractions. The summary prints inserted / updated / unchanged / skipped per file.
- Everywhere else in the API a country is referenced by its `code` (`EG`), a city by `city_id`
  (`cairo`), an airport by `iata_code` (`CAI`) and an attraction by `attraction_id` (`att-1`);
  unknown IDs are rejected with `400`. Supported currencies are the distinct `currency` values
  of `Countries.csv` (`GET /api/currencies`). Run the import before creating hotels, flights or itineraries.

### Booking holds, concurrency and lifecycle (HTL-18, FLT-22, GEN-11)

- Proceeding to payment holds every selected room (or flight seats) as one **Pending Payment**
  reservation for `BOOKING_HOLD_MINUTES` (default **10**, one constant for hotels and flights).
- The hotel availability check and the hold run in one MongoDB transaction; every writer that changes
  room availability (hold, block, availability, deactivate, delete) also bumps `Room.holdSeq`, so two
  overlapping requests cannot both succeed. Persistent contention returns `409`, never `500`.
- Allowed status transitions only: Pending Payment -> Confirmed -> Completed, Pending Payment -> Expired,
  Confirmed -> Cancelled. Cancelling an unpaid hold releases it as Expired.
- A per-minute job completes Confirmed bookings (hotel: after the check-out day; flight: after departure).
- `npm test` is fast and offline. `npm run test:integration` runs the concurrency tests against an
  in-memory MongoDB replica set (first run downloads a mongod binary; never touches Atlas).

### Route aliases (project PDF, Section 8)

The routes named in the PDF are the main ones; the earlier routes keep working and are listed in Swagger as
"legacy alias of ...". Each alias runs the same service method with the same authentication, role and ownership checks.

| Main route (PDF) | Legacy route |
| --- | --- |
| `POST /api/flight-bookings/:id/cancel` | `DELETE /api/flight-bookings/:id` |
| `POST /api/hotel-bookings/:id/cancel` | `DELETE /api/hotel-bookings/:id` |
| `POST /api/flight-bookings/hold` | `POST /api/flight-bookings` |
| `PATCH /api/itineraries/:id/days/reorder` | `PATCH /api/itineraries/:id/days/order` |
| `POST /api/payments/webhook` | `POST /api/stripe/webhook` |
| `PATCH/DELETE /api/activities/:id` | `.../itineraries/:id/days/:dayId/activities/:activityId` |
| `PATCH/DELETE /api/budgets/:id` | `.../days/:dayId/budget-entries/:entryId` |
| `POST /api/itineraries/:id/days/:dayId/budgets` | `.../days/:dayId/budget-entries` |
| `PATCH/DELETE /api/transport-costs/:id` | `.../itineraries/:id/transport-costs/:costId` |
| `GET /api/hotels/:id/availability` (moderator, own hotel) | `GET /api/hotels/:id/rooms/status` |
| `PUT /api/hotels/:id/policies` (moderator, own hotel) | `PATCH /api/hotels/:id` |
| `PATCH /api/auth/change-password` | `POST /api/auth/change-password` |

New views over existing data: `GET /api/itineraries/:id/budget-summary` (the `budgetSummary` section of the itinerary)
and `GET /api/refunds/:id`. A refund is not a separate record yet: its id is the **payment id**. Cancellation responses and
`GET /api/payments/:id` return it as `refundId` (null when nothing is refunded); `GET /api/refunds/:id` is 404 when the payment has no refund.

> **Warning: `POST /api/flight-bookings/hold` and `POST /api/flight-bookings` are the same operation.** Creating the booking
> IS the hold (a Pending Payment booking that holds the seats for 10 minutes). **Do not call both** for the same trip: that
> creates two pending bookings and holds the seats twice.

`GET /api/hotels/:id/rooms/available` (the public room search) is intentionally not part of this change.

### Payments, policies and the platform currency (PAY-01, PAY-02, PAY-04)

**Flow** (the same for hotel and flight bookings, `:type` is `hotel` or `flight`):

1. Create a hold (`POST /api/hotel-bookings` or `POST /api/flight-bookings`). `policiesAccepted: true` there records `policiesAcceptedAt`; leaving it out creates the booking unaccepted.
2. `GET /api/bookings/:type/:id/policies` shows the provider policies: hotel cancellation tiers and check-in/check-out times; flight cancellation tiers and the baggage policy. They are **snapshotted on the booking** at creation, so what the user accepts cannot change later. Owner only (another user's booking is 404).
3. `POST /api/bookings/:type/:id/accept-policies` with body `{ "accepted": true }` stores `policiesAcceptedAt` (a second call keeps the first timestamp). Payment is blocked (409) until then.
4. `POST /api/payments` with `{ "bookingType": "hotel" | "flight", "bookingId": "..." }` creates a Stripe **PaymentIntent** and returns `{ paymentId, clientSecret, amount, amountMinor, currency }`. `amount` is in major units (`4500.5`), `amountMinor` in Stripe's minor units (`450050`). The amount and currency always come from the **booking**, never from the client. The browser passes `clientSecret` to Stripe Elements, so card details never reach this backend. Only the PaymentIntent id, amount, currency and status are stored; the client secret is never stored or logged.
5. **The booking is confirmed only by Stripe's signed webhook** (`POST /api/payments/webhook`, `payment_intent.succeeded`). The handler checks the signature on the raw body, is idempotent per Stripe event id, and confirms only if the PaymentIntent is the one we created, its amount and currency equal the booking's, and the booking is still Pending Payment with a valid hold. Anything else is **not** confirmed: it is logged (ids only) and, because the money was taken, the payment is flagged Refund Pending for the existing refund path. A success that arrives after the hold expired therefore never confirms an Expired booking. `payment_intent.payment_failed` marks the payment Failed and leaves the booking Pending Payment.
6. After a failed attempt, `POST /api/payments/:id/retry` lets the user try again until the hold expires (same PaymentIntent while Stripe says it is still usable, otherwise a new one). When a hold expires, or an unpaid booking is cancelled, its PaymentIntent is cancelled.
7. `GET /api/payments/:id` shows the status (owner only).

State conflicts (policies not accepted, hold expired, booking not Pending Payment) are `409`; malformed input is `400`.

**Receiving webhooks locally.** Stripe cannot reach `localhost`, so forward events with the Stripe CLI (test mode):

```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

It prints a signing secret that starts with `whsec_`. Put it in `backend/.env` as `STRIPE_WEBHOOK_SECRET=whsec_...` (together with your `sk_test_...` key as `STRIPE_SECRET_KEY`) and restart the backend. Without it the webhook answers 400/503 and no booking is ever confirmed.

**Paying from Swagger (test mode only).** Nobody can type a card into Stripe Elements in Swagger, so `POST /api/payments/:id/test-confirm` confirms the PaymentIntent on the server with Stripe's test card `pm_card_visa` (body `{ "outcome": "decline" }` uses `pm_card_chargeDeclined` to simulate a failure). It does **not** confirm the booking: that still happens only when the signed webhook arrives, exactly like a real payment, so keep `stripe listen` running. It answers 404 unless `STRIPE_SECRET_KEY` starts with `sk_test_` **and** `NODE_ENV` is not `production` (and boot validation already refuses any Stripe key that is not a test key). Demo order: hold, `GET policies`, `accept-policies`, `POST /payments`, `test-confirm`, then `GET /payments/:id` and the booking.

**One platform currency (PAY-04).** `PLATFORM_CURRENCY` (default `USD`). Room and cabin creation and update take an optional `currency`: omitted means the platform currency, and any other value is a 400 on the `currency` field (`currency must be USD`). A booking priced in another currency (data created before this rule) cannot be paid (409). Rooms and cabins already stored in another currency, for example older demo data in EGP, must be recreated in the platform currency before they can be paid.

Known gap: the airline **baggage policy** has its own `currency` (price of an extra bag); it is not restricted to the platform currency yet.

### Authentication cookies and `COOKIE_SECURE`

Auth tokens are only ever sent as `httpOnly` cookies (never in a response body). Cookie flags:

| Setting | Behaviour |
| --- | --- |
| `httpOnly` | always on |
| `Secure` | `COOKIE_SECURE=true` -> on, `false` -> off; **unset -> on when `NODE_ENV=production`, off otherwise** |
| `SameSite` | `None` when Secure (cross-site frontend), `Lax` otherwise |

Production does not refuse to start with `COOKIE_SECURE=false` (Safari and some browsers drop Secure cookies on plain
`http://localhost`, which would break a local demo run in production mode); it logs a startup warning instead.
Behind HTTPS always leave it on. For a local demo in either mode set `COOKIE_SECURE=false` over http, or `true` over https.

Related behaviour: 5 failed logins lock an account for 15 minutes (HTTP 423, `lockedUntil` in the body); a session idle
for 30 minutes expires; logout revokes the server-side refresh token and clears the cookies; refresh tokens rotate (the previous one stops working).
**Security note:** a copied access token stays valid until its 15-minute expiry after logout, by design (there is no access-token blacklist).
Validation errors are field-level: `{ "message": "Validation failed", "errors": [{ "field": "password", "messages": ["..."] }] }`.

### Flight search (`GET /api/flights/search`, `GET /api/flights/:id`)

Both are public (guests can search). Search lists **Scheduled, not-yet-departed flights of active airlines** with enough free seats (`availableSeats` is already total - booked - held).

| Parameter | Rule |
| --- | --- |
| `origin`, `destination` | required; 3-letter IATA code that exists in the imported airports (unknown code = 400); must differ |
| `departureDate` | required `YYYY-MM-DD`, the **local date at the departure airport**; "past" is judged by today's date at that airport |
| `returnDate` | optional round trip; local date at the **destination** airport, not before `departureDate`. The response then also has `return` options (destination to origin, departing after the earliest outbound arrival) |
| `adults` (default 1, min 1), `children`, `infants` | each 0-9. Seats needed = adults + children. Infants take no seat and pay 10% of the fare; infants must not exceed adults |
| `cabinClass` | `Economy`, `Premium Economy`, `Business` or `First` |
| `minPrice`, `maxPrice` | inclusive, per seat, in the stored platform currency (no conversion); min > max = 400 |
| `airlineId`, `sortBy` (`price` / `duration` / `departure`, default departure), `order` (`asc` / `desc`), `page`, `limit` (default 10) | |

Every bad value is a 400 with the error on the right field (`{ "errors": [{ "field": "adults", ... }] }`), never an empty 200. No match is a 200 with `"message": "No flights found"`. Times are returned both as airport-local time (`local`, `utcOffset`, `timeZone`) and as the UTC instant. Each cabin has `estimatedTotal = (adults + children) x price + infants x 10% of price`. The search logic is one method, `FlightSearchService.search`, which takes **lists** of airports so a later "any airport in a city" search can reuse it. It is backed by the compound index `Flight { departureAirport, arrivalAirport, departureTime, status }`. `GET /flights/:id` also returns the airline's cancellation and baggage policies (`null` when not set).

The public reference and airport lists (`/airports`, `/countries`, `/cities`, `/attractions`) default to 10 per page; a malformed `page`, `limit`, `countryCode`, `cityId` or `parentId` is 400, while a well-formed unknown value gives an empty list.

### Hotel search and room availability (`GET /api/hotels/search`, `GET /api/hotels/:id/rooms/available`)

Both are public. **One rule decides whether a room is free**, in `backend/src/modules/hotels/room-availability.ts`, and hotel search, `rooms/available`, the moderator room statuses (`GET /hotels/:id/availability`), hotel details and the booking hold all call it, so search and booking cannot disagree. A room is free for a stay when it is active, every night of the stay is covered by its availability ranges, no blocked range overlaps, and no Confirmed reservation or *unexpired* Pending Payment hold overlaps (an expired hold frees the room at once, even before the expiry job runs).

* **Ranges that touch count as one.** 1-5 and 5-10 cover a stay of 3-8; a real gap (even one night) breaks coverage. Range end dates are exclusive.
* **Search parameters:** exactly one of `city` (a `city_id`) or `country` (a code); `checkIn`, `checkOut` (strict `YYYY-MM-DD`, check-out after check-in, check-in not in the past); `guests` (required, at least 1); `rooms` (default 1); `minPrice`, `maxPrice`; `minRating` (1-5); `sortBy` (`price` or `rating`) and `order`; `page`, `limit` (10 by default, max 100). Every bad value is a 400 on the right field; a well-formed but unknown city or country is an empty 200 with "No hotels found".
* A hotel matches when it is active and has at least `rooms` free rooms whose best `rooms` capacities together hold the guests. The price filter and price sort use the price per night of the **cheapest free room**; the rating filter and sort use the stored `averageRating` (unrated hotels are excluded when `minRating` is set, and sort last).
* **"Check-in cannot be in the past" uses the UTC date**, because hotels have no stored time zone.
* **Ratings** are stored on the hotel (`averageRating`, `ratingCount`, null / 0 = unrated) and are refreshed by `HotelsService.refreshRating(hotelId)`. Nothing calls it yet: real hotels stay unrated until the reviews task creates reviews and calls it.
* **Why search runs in memory, on purpose.** It makes three batched queries (the hotels of the city or country, all their rooms, and the relevant reservations and holds), applies the shared rule in code, and only then filters, sorts and pages, so pages and totals are exact and there is no N+1. A single database aggregation would need the free-room rule written a second time as a database expression, which could drift from the one booking uses; consistency with booking is worth more than pushing the work into the database. It scales with the hotels of one city or country, not the whole catalogue. The search method (`HotelSearchService.search`) takes a criteria object with lists of cities and countries so the itinerary hotel search (ITN-25) can reuse it.
* **Deleting a room** is rejected if *any* booking record references it, including Expired and Cancelled ones, because booking history keeps pointing at the room (deactivate it instead). Deactivating, blocking or removing availability is rejected while a Confirmed reservation or unexpired hold overlaps.
* **Indexes:** `Hotel { isActive, cityId, averageRating }`, `Hotel { isActive, countryId, averageRating }`, `Room { hotelId, isActive }`; reservations use the existing `HotelBooking { rooms.roomId, status, checkInDate, checkOutDate }`.

## 8. Testing

Run unit tests:

```bash
npm test
```

Run tests with coverage:

```bash
npm run test:cov
```

Run lint:

```bash
npm run lint
```

### End-to-end tests (`npm run test:e2e`)

```bash
cd backend
npm run test:e2e                       # everything
npm run test:e2e -- holds              # one file (name filter)
npm run test:e2e -- aliases -t "refund" # one file, tests whose name matches
```

These tests boot the **real** Nest app (`AppModule`, the real guards, the real `ValidationPipe`, real cookies, the same setup as `main.ts` through `configureApp`) on an **in-memory MongoDB replica set** and drive it over HTTP with supertest. They never read `MONGODB_URI` and never touch Atlas: the boot helper refuses to start unless the app is connected to the in-memory database. Each test file starts its own app and database, so files are independent; inside a file every test creates its own users and providers with unique emails. The first run downloads a `mongod` binary (cached afterwards). A full run takes about 2.5 minutes; at most 2 files run at once.

**What is mocked (and nothing else):**

| Mocked | Where | Why |
| --- | --- | --- |
| Stripe (`StripeService`) | `test/e2e/helpers/fakes.ts` (`StripeFake`) | no network; models PaymentIntents (create, retrieve, cancel, confirm), records refunds; builds `payment_intent.*` events; accepts only the signature `valid` |
| Exchange rates (`FxRatesService`) | `test/e2e/helpers/fakes.ts` (`FxFake`) | fixed rates |
| Throttle counter (`ThrottlerStorage`) | `test/e2e/helpers/app.ts` | 100 requests/minute would break lockout and concurrency tests. The real guard still runs |

**Confirmed bookings** are created through the real payment path by `confirmBooking()` in `test/e2e/helpers/bookings.ts`: accept the policies, open a payment (`POST /api/payments`), then post a fake-signed `payment_intent.succeeded` event to `POST /api/payments/webhook`. Stripe event details live in that helper and in `StripeFake`; `payments.e2e.ts` also builds failure, wrong-amount and late events through the fake.

**Layout.** One file per area in `test/e2e/` (`holds`, `auth`, `auth-secure-cookie`, `aliases`, `reference`, `users`, `admin`, `flight-search`, `hotel-search`, `payments`, `payments-production`); shared helpers in `test/e2e/helpers/`:

| Helper | Purpose |
| --- | --- |
| `startApp()` / `ctx.close()` | boot and stop the app; `ctx.agent()` is a fresh cookie jar, `ctx.http()` is anonymous, `ctx.get(Service)` reaches a real provider (e.g. to run a cron job method) |
| `createUser(ctx, role)` | account + logged-in supertest agent (`user.agent`) |
| `login(ctx, email, password)` | a new logged-in agent |
| `createHotelWithRooms(ctx, opts)` | hotel via the admin API, hotel moderator, rooms, availability range |
| `createAirlineWithFlight(ctx, opts)` | airline, airline moderator, a future CAI to DXB flight and an Economy cabin (call `seedReference` first) |
| `seedReference(ctx)` | runs the real CSV importer on `backend/data/reference` |
| `holdHotel`, `holdFlight`, `acceptPolicies`, `startPayment`, `sendWebhook`, `confirmBooking` | booking helpers; `day(n)` gives a date `n` days from today |

**Adding the next feature's tests**

1. Create `test/e2e/<area>.e2e.ts` (the name must end in `.e2e.ts`).
2. In `beforeAll` call `startApp()` (add `{ swagger: true }` only if you check the Swagger JSON) and `seedReference(ctx)` if you need cities, airports or currencies; call `ctx.close()` in `afterAll`.
3. Build data with the helpers, one scenario per `it`, each creating its own users and providers.
4. Use `agent` for logged-in calls (`user.agent.get('/api/...')`) and `ctx.http()` for anonymous ones. To control time, back-date a field through `ctx.conn.model('HotelBooking')` and call the job method with `ctx.get(PaymentsService)`.
5. If the feature needs a new external service, replace it in `startApp()` with a fake in `helpers/fakes.ts`; do not mock your own services.
6. Commit as `test(e2e): <area> (<requirement ids>)`.

A needed `import { Connection } from 'mongoose'` in a class used by Nest's dependency injection must be `import type { Connection }`; the ESM test loader rejects the value import.

## 9. API Documentation

Swagger UI:

```text
http://localhost:3000/docs
```

The global API prefix and port depend on the backend configuration.

## 10. Development Guidelines

- Follow the existing NestJS module structure.
- Keep controllers responsible for handling HTTP requests.
- Implement business logic inside services.
- Validate incoming requests on the backend.
- Enforce authentication, authorization, and ownership restrictions.
- Reference official requirement IDs in related commits and pull requests.
- Do not commit environment files, secrets, or generated build files.

## 11. Git Workflow

Use feature branches created from `develop`.

Example:

```bash
git checkout develop
git pull origin develop
git checkout -b feature/ACC-01-registration
```

Submit completed work through pull requests targeting `develop`.
