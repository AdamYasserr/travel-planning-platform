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
- A per-minute job completes Confirmed bookings (hotel: after the check-out day; flight: after the departure of its last flight, which is the return of a round trip).
- `npm test` is fast and offline. `npm run test:integration` runs the concurrency tests against an
  in-memory MongoDB replica set (first run downloads a mongod binary; never touches Atlas).

### Flight bookings: passengers, round trips and extra baggage (FLT-12, FLT-19, FLT-08)

`POST /api/flight-bookings` (and its alias `/hold`) creates ONE Pending Payment booking with one reference and, later, one payment.

```json
// One-way: the shape used so far (or { "outbound": { ... } } without "return")
{ "flightId": "<id>", "cabinClass": "Economy", "policiesAccepted": true,
  "passengers": [{ "fullName": "Sara Ali", "dateOfBirth": "1990-04-02",
                   "passportNumber": "A1234567", "passportExpiry": "2031-01-01", "nationality": "EG",
                   "extraBags": { "outbound": 1 } }] }

// Round trip: each segment picks its cabin by cabinClass OR cabinId (from search / flight details)
{ "outbound": { "flightId": "<id>", "cabinClass": "Economy" },
  "return":   { "flightId": "<id>", "cabinId": "<cabin id>" },
  "passengers": [{ "fullName": "Sara Ali", "dateOfBirth": "1990-04-02", "nationalId": "29004020101234",
                   "nationality": "EG", "extraBags": { "outbound": 1, "return": 2 } }] }
```

- **Passengers.** Each passenger needs `fullName`, `dateOfBirth`, `nationality` (a code from `GET /api/countries`) and **either** `passportNumber` (6-9 letters or digits, with `passportExpiry` after the arrival of the last flight) **or** `nationalId` (not both). The type is **derived** from the date of birth on the outbound departure day (adult 12+, child 2-11, infant under 2) and is never sent. At least one adult, no more infants than adults, at most 9 adults and children. The new passenger fields are optional in the database, so bookings made before them still load.
- **Round trip.** Both flights must be Scheduled, in the future and from active airlines (409). The return must fly the reverse route (400) and depart **after** the outbound arrival in UTC (409). A cabin id must belong to its flight (400). Errors name the field (`return.flightId`, `passengers.0.passportExpiry`, ...). The cabin class may differ per segment; each segment is priced at its own cabin fare.
- **Seats.** One transaction holds the seats on every flight of the booking, or on none: a shortage on either flight is 409 and nothing is held. Adults and children take a seat; infants do not.
- **Price** (computed on the server only, in minor units of the platform currency). Per flight: seats x fare + infants x 10% of the fare (rounded per infant) + extra bags x fee per bag; the total is the sum over the flights. Example (EGP): outbound 1,500.00 and return 1,350.50, two adults, one child and one infant, one extra bag out and two back at 250.00: outbound 3 x 1,500.00 + 150.00 + 250.00 = 4,900.00; return 3 x 1,350.50 + 135.05 + 500.00 = 4,686.55; total **9,586.55**. The booking stores the breakdown in `pricing`.
- **Extra baggage.** Per passenger and direction (`extraBags.outbound`, `extraBags.return` on a round trip only). The maximum per passenger and the fee come from the airline's baggage policy (over the maximum is 400); the cabin's free bags stay free. The baggage policy's price must be in the platform currency: `PUT /api/airlines/:id/baggage-policy` treats an omitted `currency` as the platform currency and rejects any other one (`currency must be <PLATFORM_CURRENCY>`). If a stored policy is in another currency, or the airline has none, a request for extra bags is refused with 409 (bookings without extra bags are unaffected).
- **Lifecycle.** The whole booking is cancelled as one. The refund tier and the "no cancel after departure" check use the **outbound** departure (the outbound airline's tiers are snapshotted). The booking stays upcoming, and Confirmed, until the **return** departs, then completes. If the airline cancels either flight (FLT-06), the whole booking is cancelled and refunded 100%. Every seat release (expiry, cancellation) frees the seats on both flights.
- **Rescheduling.** When a flight's departure or arrival changes, the time copies on every Pending Payment or Confirmed booking that includes it (one-way, outbound or return) are updated in the same transaction as the flight, then the schedule-change notification is sent. An edit that would make a booked round trip's return depart before its outbound arrival, or that changes the airports of a flight in a booked round trip, is 409.
- **Stored fields** (all optional, no migration): passengers `type`, `passportNumber`, `passportExpiry`, `nationalId`, `nationality`, `extraBags`; booking `seatCount` (missing means one seat per passenger, as before), `pricing`, `tripType` (missing means one-way), `arrivalTime`, `returnSegment`.

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
and `GET /api/refunds/:id`. A refund is its own record with its own id (see "Refunds" below). Cancellation responses and
`GET /api/payments/:id` return it as `refundId` (null when nothing is refunded); a payment id is not a refund id.

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
5. **The booking is confirmed only by Stripe's signed webhook** (`POST /api/payments/webhook`, `payment_intent.succeeded`). The handler checks the signature on the raw body, is idempotent per Stripe event id, and confirms only if the PaymentIntent is the one we created, its amount and currency equal the booking's, and the booking is still Pending Payment with a valid hold. Anything else is **not** confirmed: it is logged (ids only) and, because the money was taken, a 100% refund is opened (see "Refunds" below). A success that arrives after the hold expired therefore never confirms an Expired booking. `payment_intent.payment_failed` marks the payment Failed and leaves the booking Pending Payment.
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

The airline **baggage policy** (price of an extra bag) follows the same rule; see "Flight bookings" above.

### Refunds (PAY-03)

- A refund is a **Refund record** linked to its payment and booking: amount and currency (from our payment record, never from the client, never more than was paid), percentage, reason (`booking_cancelled`, `flight_cancelled`, `late_payment`, `payment_mismatch`), status, Stripe refund id and timestamps. **At most one refund per payment** (unique index), so cancelling twice or retrying never refunds twice; Stripe is also called with the idempotency key `refund-<paymentId>`.
- **When:** a user cancels a Confirmed booking (the cancellation tier snapshotted on the booking decides the share: the largest tier still met wins; 0% means no refund record, the booking is still Cancelled and the user is notified); an airline or admin cancels a flight (100%); a payment succeeds after its hold expired or with a wrong amount or currency (100% of what Stripe received).
- **How:** the record is created inside the same transaction as the cancellation, and the Stripe Refunds API is called on the original PaymentIntent after the commit. States: `Pending` -> `Refunded` or `Failed`. Both are final.
- **Webhooks** (`POST /api/payments/webhook`, signature-checked, idempotent per event id): `refund.updated`, `refund.failed` and `charge.refunded`. Subscribe to them in Stripe (and to `payment_intent.succeeded` / `payment_intent.payment_failed`).
- **Retry job:** the existing 5-minute scheduler job (`retryPendingRefunds`) resends only refunds Stripe never accepted (network error, process stopped). Each refund is leased before Stripe is called, so two runs at once never send it twice.
- **A failed refund is final:** the user is notified and nothing retries it automatically (Stripe would return the same failed refund for the same key). It needs **manual handling in the Stripe dashboard**.
- `GET /api/refunds/:id`: the owner or an admin; anyone else gets 404.

### Flight cancellation by the airline (FLT-06)

`POST /api/flights/:id/cancel` (the airline's moderator or an admin; 403 for anyone else). In **one transaction** (`runBookingTransaction`, all or nothing): the flight becomes Cancelled (it disappears from search and cannot be booked), Pending Payment holds on it are expired and their seats released (their PaymentIntents are cancelled), and every Confirmed booking becomes Cancelled with a **100% refund**. Completed bookings are not touched. Every affected user is notified. Cancelling an already cancelled or departed flight is 409.

### Notifications (GEN-01)

One `NotificationsService.notify(userId, type, payload)` is used for every event: booking confirmed, booking cancelled, refund started / completed / failed, flight schedule changed (departure or arrival time edited; Confirmed bookings only), flight cancelled, account suspended / reactivated, provider deactivated. The payload holds ids, statuses and amounts only. Notifications are sent after the business change has committed and never throw, so a lost notification can never undo a booking or a refund.

`GET /api/notifications` (yours only, newest first, 10 per page, `limit` up to 100), `PATCH /api/notifications/:id/read`, `PATCH /api/notifications/read-all`.

### E-ticket (FLT-23)

`GET /api/bookings/:id/e-ticket` returns a PDF attachment (`e-ticket-<reference>.pdf`) for a **Confirmed or Completed flight booking**: booking reference, passengers (children and infants marked), flight number, airline, departure and arrival airports with **local times**, cabin, baggage allowance, total paid and currency. A round trip prints the return flight as well (flight, airline, airports, local times, cabin, baggage). Passport numbers are not printed. Seats are assigned at check-in (not stored). Owner or admin only; another user's booking or a hotel booking id is 404; any other status is 409. Built with `pdfkit`.

### Provider views (FLT-29, HTL-22)

- `GET /api/flights/:id/bookings` (that airline's moderator or an admin; anyone else 403): one row per booking with reference, status, `tripType`, `direction` (`outbound` or `return`), the cabin booked on this flight, passenger names, `passengerDetails` (type, passport or ID, nationality, extra bags on this flight), passenger counts by type (adult 12+, child 2-11, infant under 2 on the outbound departure day) and booked-at; newest first, 10 per page, optional `status`. A round trip is listed on both of its flights. The response also lists the seats left in each cabin.
- `GET /api/flights/:id/passengers/export` (same access): a `text/csv` attachment with one row per passenger of every Confirmed or Completed booking on the flight (round trips included, with this flight's cabin): `booking_reference, full_name, type, cabin, passport_or_id, nationality, status`. `passport_or_id` is the passport number, else the national ID; both columns are empty for bookings made before passengers carried them. **CSV injection:** a cell that starts with `=`, `+`, `-`, `@` (or a tab or carriage return) gets a leading `'`, and quotes, commas and line breaks are escaped (RFC 4180).
- `GET /api/hotels/:id/reservations` (that hotel's moderator or an admin): guest name ("Deleted user" for a deactivated account), rooms, check-in/out, status, total and reference; newest first, 10 per page. Filters: `status`, and `from`/`to` (YYYY-MM-DD), which keep stays that overlap the range (both days included).

### Hotel reviews (HTL-23, HTL-24)

- `POST /api/hotel-bookings/:id/review` with `{ "rating": 1-5, "comment"?: "..." }`: the booking's owner, only once the stay is **Completed** (409 otherwise), one review per reservation (a second is 409). `rating` is a whole number (the string `"5"` is rejected); `comment` is at most 1000 characters. A deactivated hotel can still be reviewed by its guest.
- `PATCH /api/reviews/:id` (the author) and `DELETE /api/reviews/:id` (the author or an admin); anyone else gets 404.
- Each create, edit and delete runs in one transaction with the hotel's **full recount** of visible reviews (`refreshRating`), so the stored `averageRating`/`ratingCount` never double count and the last delete makes the hotel unrated. Reviews hidden or deleted through report moderation are recounted too. Hotel search (`minRating`), hotel details and the review list all read the stored values; every hotel is recounted once when the app starts (idempotent).
- `GET /api/hotels/:id/reviews` (public): average, count and the visible reviews, newest first, 10 per page, with rating, comment, author name ("Deleted user" for a deactivated account) and dates. An unknown or inactive hotel is 404. Hotel details embed the 10 newest reviews.

### My bookings: groups and the e-ticket alias (FLT-25, HTL-20, FLT-23)

`GET /api/flight-bookings` and `GET /api/hotel-bookings` take an optional `group`:

| group | contains |
| --- | --- |
| `upcoming` | Confirmed, or a still-live Pending Payment hold, whose trip is not finished (a hotel stay in progress counts; a round trip counts until its return departs) |
| `past` | Completed, or Confirmed and finished before the completion job ran |
| `cancelled` | Cancelled, Expired, or a Pending Payment hold whose hold has lapsed |

Without `group`, everything is listed as before; any other value is 400. The e-ticket is also served at `GET /api/flight-bookings/:id/e-ticket` (an alias of `GET /api/bookings/:id/e-ticket`, same rules).

### Itineraries: days, budget, images, public view, clone and search (ITN-05 to ITN-26)

**Days and city groups (ITN-05, ITN-09).** A day has **no stored date**: it is derived on read as `startDate + dayNumber - 1` (UTC calendar days), so adding, deleting or reordering days and editing the start date keep dates and numbering consistent. A date in a request is rejected (400). An itinerary has at most **60 days**, with or without an `endDate`. Every itinerary response has `days[].date` and `cityGroups`: runs of consecutive days in the same city, in day order, computed on read (Cairo, Dubai, Cairo gives three groups; it is never an error).

**Budget summary (ITN-14, ITN-18).** `GET /api/itineraries/:id/budget-summary` (and the `budgetSummary` section of `GET /api/itineraries/:id`), in the itinerary's `displayCurrency` or `?currency=`:

```json
{ "itineraryId": "...", "currency": "USD", "plannedTotal": 80.8, "actualTotal": 16,
  "breakdown": { "food": { "planned": 2, "actual": 11 }, "accommodation": { "planned": 50, "actual": 0 },
                 "in_city_transport": { "planned": 22, "actual": 0 }, "activities": { "planned": 6, "actual": 5 },
                 "intercity_transport": { "planned": 0.8, "actual": 0 } },
  "grandTotal": { "planned": 80.8, "actual": 16 },
  "exchangeRates": [{ "from": "EUR", "to": "USD", "rate": 1.1, "fetchedAt": "2026-11-18T08:00:00.000Z", "stale": false }],
  "ratesAsOf": "2026-11-18T08:00:00.000Z" }
```

`intercity_transport` is the itinerary's transport costs (they count as planned). `grandTotal` equals `plannedTotal` / `actualTotal`. `ratesAsOf` is the oldest `fetchedAt` of the rates used (`null` when nothing was converted). Booking prices and activity `cost` are not counted. Conversion uses the existing exchange-rate service; no new external calls.

**Activity images (ITN-12).** `POST /api/activities/:id/images` (multipart field `file`) and `DELETE /api/activities/:id/images/:imageId`. Only the itinerary's owner: an unknown activity or someone else's is **404**. Images appear on each activity as `images: [{ id, url }]`; the owner's URL (`/api/media/:id/content`) is owner-only, and the public view uses `/api/media/public/:id/content`, which works only while the itinerary is public. Removing an activity, day or itinerary removes its images.

**Upload limits (GEN-08).** One set in `src/modules/media/media.limits.ts`, used by `POST /api/media`, `POST /api/posts/:id/images` and the activity route:

| Rule | Value | Error |
| --- | --- | --- |
| Type | JPG or PNG, checked by extension, MIME type, magic bytes and a real decode | 400 |
| Size | 1 byte to 5 MB, one file per request (multer's 413 is answered with 400) | 400 |
| Hotel photos / post images / activity images | at most 5 each (one logo per airline) | 409 |

**Public itineraries (ITN-20, ITN-21).** No sign-in needed.
- `GET /api/itineraries/public/search`: only public itineraries, newest first, 10 per page (`limit` up to 100). Filters (all optional, validated): `city` (a city_id with a day in it), `country`, `from` / `to` (`YYYY-MM-DD`; the itinerary overlaps the range; one without an end date runs for as many days as it has; `from` after `to` is 400). Items: `id`, `title`, `countryIds`, `startDate`, `endDate`, `dayCount`, `cities`, `author: { name }`, `clonedFrom`, `createdAt`.
- `GET /api/itineraries/public/:id`: days (derived date, city, notes), activities (`name`, `description`, `time`, `images`), `cityGroups`, `author: { name }` ("Deleted user" for a deactivated account). **Never** budgets, transport costs, linked bookings, activity costs, the owner's id or e-mail. A private, hidden or unknown itinerary is **404** for everyone, the owner included; a malformed id is 400.

**Clone (ITN-21).** `POST /api/itineraries/:id/clone` (signed in), optional body `{ "startDate": "2027-03-01" }`. The source must be public or your own (otherwise 404). Creates a new **private** itinerary of yours with `clonedFrom: { itineraryId, authorName }`. Copied: title, countries, days, notes, activity name / description / time, **planned** budget entries and transport costs. Never copied: images, activity costs, actual spending, booking links, payments. `startDate` moves the whole clone (day dates are derived; an end date keeps its distance).

**Search in the itinerary's context (ITN-25, ITN-26).** Owner only (anyone else 404). They pick a city group with `group` (its number in `cityGroups`, from 1) or `city` (its first group); the default is group 1. The searching is the existing `HotelSearchService` / `FlightSearchService`, so the result equals `GET /hotels/search` / `GET /flights/search` with the same parameters; the response adds `itineraryId` and `context`.
- `GET /api/itineraries/:id/hotels?guests=2`: the group's city, check-in on its first day, check-out the day after its last day. `checkIn` / `checkOut` may narrow the stay inside that span (400 otherwise). All hotel search filters (`rooms`, `minPrice`, `maxPrice`, `minRating`, `sortBy`, `order`, `page`, `limit`) work.
- `GET /api/itineraries/:id/flights`: flies INTO the group's city, from `fromCity` (default: the city of the previous group; required for group 1), from every airport of one city to every airport of the other, on `date` (default the group's first day; at most one day earlier). All flight filters (`adults`, `children`, `infants`, `cabinClass`, prices, `airlineId`, sorting, paging) work.

### Page size (GEN-05)

Every list defaults to **10 per page**; `limit` is accepted up to 100 and `page`/`limit` must be positive whole numbers (400 otherwise). This covers: admin accounts, bookings, audit logs and reports; posts, my posts, tag posts, the author page and post comments; notifications; flight and hotel bookings; the airline and hotel views above; hotel reviews; reference lists and airports; flight and hotel search; public itinerary search.

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

Every bad value is a 400 with the error on the right field (`{ "errors": [{ "field": "adults", ... }] }`), never an empty 200. No match is a 200 with `"message": "No flights found"`. Times are returned both as airport-local time (`local`, `utcOffset`, `timeZone`) and as the UTC instant. Each cabin has its `id` (send it as `outbound.cabinId` / `return.cabinId` when booking) and `estimatedTotal = (adults + children) x price + infants x 10% of price`. The search logic is one method, `FlightSearchService.search`, which takes **lists** of airports so a later "any airport in a city" search can reuse it. It is backed by the compound index `Flight { departureAirport, arrivalAirport, departureTime, status }`. `GET /flights/:id` also returns the airline's cancellation and baggage policies (`null` when not set).

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
| Stripe (`StripeService`) | `test/e2e/helpers/fakes.ts` (`StripeFake`) | no network; models PaymentIntents (create, retrieve, cancel, confirm) and refunds (`nextRefundOutcomes` picks succeeded, pending, failed or a network error); builds `payment_intent.*`, `refund.*` and `charge.refunded` events; accepts only the signature `valid` |
| Exchange rates (`FxRatesService`) | `test/e2e/helpers/fakes.ts` (`FxFake`) | fixed rates |
| Throttle counter (`ThrottlerStorage`) | `test/e2e/helpers/app.ts` | 100 requests/minute would break lockout and concurrency tests. The real guard still runs |

**Confirmed bookings** are created through the real payment path by `confirmBooking()` in `test/e2e/helpers/bookings.ts`: accept the policies, open a payment (`POST /api/payments`), then post a fake-signed `payment_intent.succeeded` event to `POST /api/payments/webhook`. Stripe event details live in that helper and in `StripeFake`; `payments.e2e.ts` also builds failure, wrong-amount and late events through the fake.

**Layout.** One file per area in `test/e2e/` (`holds`, `auth`, `auth-secure-cookie`, `aliases`, `reference`, `users`, `admin`, `flight-search`, `hotel-search`, `payments`, `payments-production`, `refunds-cancellation`, `provider-views-reviews`, `round-trip-booking`, `itineraries-public-budget`); shared helpers in `test/e2e/helpers/`:

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
