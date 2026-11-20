# Travel Planning and Booking Platform

## Overview

Backend of the Travel Planning and Booking Platform (GIU Software Project I). It is a REST API built with NestJS 12 and MongoDB (Mongoose). It covers accounts and roles, flight and hotel search and booking, Stripe test payments and refunds, itineraries with budgets, reviews, notifications and a community blog.

- All routes are under `/api` (for example `http://localhost:3000/api/flights/search`).
- Swagger UI: `http://localhost:3000/docs` (the Swagger page is not under the `/api` prefix; see `backend/src/app.setup.ts`).
- The code is in `backend/`. Run every command below from `backend/` unless it says otherwise.
- Longer per-feature notes (the earlier README) are in [backend/docs/api-details.md](backend/docs/api-details.md). Seed details are in [backend/docs/seed.md](backend/docs/seed.md).

## Prerequisites

- Node.js 24 and npm. `package.json` has no `engines` field; the project is built and tested with Node 24 (`@types/node` 24).
- A MongoDB database and its connection string (MongoDB Atlas or a local server).
- A Stripe account in **test mode** (for the `sk_test_...` secret key).
- The [Stripe CLI](https://stripe.com/docs/stripe-cli), to forward webhooks to your machine.

## Setup

```bash
cd backend
npm install
cp .env.example .env     # then edit .env
npm run seed:reference   # imports countries, cities, airports and attractions (safe to run twice)
```

`.env` is ignored by git. Never commit it. The variables (all in `backend/.env.example`):

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development`, `production` or `test`. |
| `APP_NAME` | Name shown in Swagger and logs. |
| `PORT` | HTTP port. Default 3000. |
| `MONGODB_URI` | MongoDB connection string. Required. |
| `CORS_ORIGINS` | Frontend origins allowed by CORS, comma separated. Default `http://localhost:3001`. |
| `JWT_SECRET` | Secret that signs access tokens. Required, at least 32 characters. |
| `JWT_EXPIRES_IN` | Access token lifetime. Use `15m`. |
| `REFRESH_TOKEN_SECRET` | Secret that signs refresh tokens. Required, at least 32 characters, different from `JWT_SECRET`. |
| `REFRESH_TOKEN_EXPIRES_IN` | Refresh token lifetime. Use `7d`. |
| `COOKIE_SECURE` | `true` marks cookies Secure. Default: true in production, false otherwise. |
| `COOKIE_DOMAIN` | Optional cookie domain. Leave empty for the current host. |
| `STRIPE_SECRET_KEY` | Stripe test secret key (`sk_test_...`). Set together with the webhook secret. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signing secret (`whsec_...`) printed by `stripe listen`. |
| `PLATFORM_CURRENCY` | The one currency of all prices and payments. Default `USD`. |
| `FXRATES_API_KEY` | API key for exchange rates (itinerary budget conversion). |
| `FXRATES_BASE_URL` | Exchange rates API address. |
| `FXRATES_CACHE_TTL_MS` | How long a fetched rate is fresh, in milliseconds. |
| `FXRATES_STALE_TTL_MS` | How long an old rate may still be used if the API fails. Must be at least the cache time. |
| `MEDIA_STORAGE_PATH` | Folder for uploaded images. Default `uploads/media`. |
| `REFERENCE_DATA_DIR` | Optional folder of reference CSV files for `seed:reference`. |
| `SEED_PASSWORD`, `SEED_CONFIRM` | Optional, for `npm run seed` (see Seed). |
| `SEED_ADMIN_*`, `SEED_MODERATOR_*`, `SEED_USER_*` (email and password) | Only for the older `npm run seed:accounts` script. |

The hold time of a booking (`BOOKING_HOLD_MINUTES`) is not in `.env.example`: the default of 10 minutes is what the platform uses.

## Seed

```bash
npm run seed -- --yes            # creates the demo data; a second run creates nothing new
npm run seed -- --reset --yes    # removes ONLY what the seed created, then creates it again with fresh dates
```

The seed prints the database name and needs `--yes` (or `SEED_CONFIRM=yes`). It refuses `NODE_ENV=production` unless `--force` is added. Every seeded document is listed in a `seed_manifest` collection; `--reset` deletes only those and what depends on them, never real users or data. Stripe is never called.

Demo logins (password `DemoPass123`, or the value of `SEED_PASSWORD`):

| Role | Email |
|---|---|
| Admin | `admin@demo-seed.test` |
| Customer | `sara@demo-seed.test` |
| Customer | `omar@demo-seed.test` |
| Airline moderator | `airline-mod@demo-seed.test` |
| Hotel moderator | `hotel-mod@demo-seed.test` |

The seed also creates an airline, three flights, a hotel with two rooms, four bookings of Sara (Pending Payment, Confirmed, Completed without a review, Cancelled and Refunded) and two itineraries. It prints the ids to use in Swagger.

## Run

```bash
npm run start:dev                      # development, restarts on change
npm run build && npm run start:prod    # production
```

## Stripe test mode

Run the Stripe CLI in a second terminal for as long as you test payments:

```bash
stripe listen --forward-to localhost:3000/api/payments/webhook
```

Copy the `whsec_...` value it prints into `STRIPE_WEBHOOK_SECRET` and restart the server. (`/api/stripe/webhook` is an alias of the same route.)

> **Warning:** without `stripe listen` running, bookings never become Confirmed. A booking is confirmed only by the signed `payment_intent.succeeded` webhook, never by the client.

Test card: `4242 4242 4242 4242`, any future expiry, any CVC. In test mode, `POST /api/payments/{id}/test-confirm` pays with a test card for you (send `{"outcome":"decline"}` to simulate a declined card). That route does not exist when `NODE_ENV=production`.

## Tests

| Command | What it needs |
|---|---|
| `npm test` | Unit tests. Offline, no database. |
| `npm run test:integration` | Concurrency and atomicity tests on an in-memory MongoDB replica set. The first run downloads a `mongod` binary. Never touches `MONGODB_URI`. |
| `npm run test:e2e` | The real app over HTTP on an in-memory MongoDB replica set, with Stripe and exchange rates faked. The first run downloads `mongod`. A full run takes a few minutes. Never touches `MONGODB_URI`. |
| `npx tsc --noEmit` and `npm run build` | Type check and build. |

## Booking rules in brief

- **Hold:** creating a hotel or flight booking holds the rooms or seats as **Pending Payment** for 10 minutes. Creating the booking is the hold. An unpaid hold expires (status Expired) and frees the rooms or seats.
- **Status flow:** Pending Payment, then Confirmed (only through the Stripe webhook), then Completed (set automatically after check-out or after the last flight departs). A Confirmed booking can be Cancelled.
- **Cancel and refund:** cancelling a Confirmed booking refunds the share set by the cancellation tier of the hotel or airline (0% means no refund record). When an airline cancels a flight, every Confirmed booking is refunded 100%.
- **Currency:** one platform currency, `USD` by default. Rooms, cabins, baggage prices and payments must use it.
- **Round trips:** one booking with one reference, one payment and two segments (outbound and return). The return flight must fly the reverse route and depart after the outbound arrives.
- **Reviews:** only the owner of a Completed hotel stay can review it, once.

## API notes for the frontend

- **Auth:** access and refresh tokens are httpOnly cookies. Send `credentials: 'include'` (fetch) or `withCredentials: true` (axios), and list the frontend origin in `CORS_ORIGINS`. Tokens are never in a response body.
- **Passengers:** each needs `fullName`, `dateOfBirth`, `nationality` and either a passport (`passportNumber` and `passportExpiry`) or a `nationalId`, not both. The type (adult, child, infant) is computed from the date of birth and must not be sent.
- **Itinerary days:** do not send `date` when creating or editing a day. Dates are derived from the itinerary `startDate` and the day order; a request with `date` is rejected with 400.
- **Errors:** `{ "statusCode": 400, "error": "Bad Request", "message": "...", "errors": [{ "field": "passengers.0.nationality", "messages": ["..."] }] }`. Use `errors[].field` to show a message under the right input.
- **Lists:** default 10 per page, `page` and `limit` (at most 100) query parameters.
- **Dates and times:** flight times are returned both as local time with offset and as a UTC instant.

## Known limitations

- Optional bonus features are not implemented. The project description is not in this repository, so this list is what the code does not contain: seat selection (the e-ticket says "Assigned at check-in"), e-mail delivery of notifications (notifications are stored and listed in the app only), social login, two-factor authentication and real-time (websocket) updates.
- Room blocks cannot be removed through the API. `PATCH /api/hotels/{hotelId}/rooms/{roomId}/blocks` only adds blocked ranges.
- Moderator creation (`POST /api/admin/moderators`) returns no initial password. An admin sets one with `POST /api/admin/users/{id}/reset-password`, which returns a temporary password once; the moderator must change it at first login.
- The seeded Confirmed bookings use local stand-in payment ids, not real Stripe objects. Do not cancel them through the API with real Stripe keys; book a new flight for refund tests.
