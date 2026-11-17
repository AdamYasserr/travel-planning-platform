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
for 30 minutes expires; logout revokes the server-side refresh token; refresh tokens rotate (the previous one stops working).
Validation errors are field-level: `{ "message": "Validation failed", "errors": [{ "field": "password", "messages": ["..."] }] }`.

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
| Stripe (`StripeService`) | `test/e2e/helpers/fakes.ts` (`StripeFake`) | no network; records session/refund calls; accepts only the signature `valid` |
| Exchange rates (`FxRatesService`) | `test/e2e/helpers/fakes.ts` (`FxFake`) | fixed rates |
| Throttle counter (`ThrottlerStorage`) | `test/e2e/helpers/app.ts` | 100 requests/minute would break lockout and concurrency tests. The real guard still runs |

**Confirmed bookings** are created through the real payment path by `confirmBooking()` in `test/e2e/helpers/bookings.ts`: open a payment, then post a fake-signed webhook event to `POST /api/payments/webhook`. All Stripe event details live in that helper and in `StripeFake`; if payments move to PaymentIntents, change those two places, not the tests.

**Layout.** One file per area in `test/e2e/` (`holds`, `auth`, `auth-secure-cookie`, `aliases`, `reference`, `users`, `admin`); shared helpers in `test/e2e/helpers/`:

| Helper | Purpose |
| --- | --- |
| `startApp()` / `ctx.close()` | boot and stop the app; `ctx.agent()` is a fresh cookie jar, `ctx.http()` is anonymous, `ctx.get(Service)` reaches a real provider (e.g. to run a cron job method) |
| `createUser(ctx, role)` | account + logged-in supertest agent (`user.agent`) |
| `login(ctx, email, password)` | a new logged-in agent |
| `createHotelWithRooms(ctx, opts)` | hotel via the admin API, hotel moderator, rooms, availability range |
| `createAirlineWithFlight(ctx, opts)` | airline, airline moderator, a future CAI to DXB flight and an Economy cabin (call `seedReference` first) |
| `seedReference(ctx)` | runs the real CSV importer on `backend/data/reference` |
| `holdHotel`, `holdFlight`, `startPayment`, `confirmBooking` | booking helpers; `day(n)` gives a date `n` days from today |

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
