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
