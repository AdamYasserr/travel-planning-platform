# GIU Backend Test Cases — ACC-07a and assigned components

## Verification status

- **Implemented and compile-verified:** ACC-07a password reset, ACC-12
  deactivation Stage 1, GEN-09 report submission, profile management, GEN-08
  media upload, FX rates service/controller, and development seed command.
- **Implemented but not runtime-tested:** all MongoDB-backed endpoints and the
  external FX provider. MongoDB Atlas and provider access were unavailable
  during implementation.
- **Pending integration:** Flight Booking and Hotel Booking developers must
  revoke/cancel their future booking records when account deactivation is
  consumed. Their schemas are currently empty, so no booking changes were made.
- **Implemented after the initial test-case draft:** blog/community posts,
  comments, likes, post media ownership, report moderation, and moderation
  audit records. Their MongoDB-backed behavior is covered by unit tests but
  has not been manually runtime-tested.
- **Still pending:** itinerary image ownership/count integration. Itinerary
  media uploads remain disabled.

All commands below assume `cd backend`, a running API on port 3000, valid
environment variables, and cookies obtained from login.

## Authentication setup

```bash
curl -i -c cookies.txt -H 'Content-Type: application/json' \
  -d '{"email":"user@example.local","password":"DevOnlyUser123!"}' \
  http://localhost:3000/api/auth/login
```

Expected: `200`, `Set-Cookie`, and a public user object without password or
refresh-token fields.

## ACC-07a — admin-assisted password reset

```bash
curl -i -b admin-cookies.txt -X POST \
  http://localhost:3000/api/admin/users/<USER_ID>/reset-password
```

Expected: admin `200` with a one-time `temporaryPassword` and
`mustChangePassword: true`. A normal user receives `403`; an invalid ID
receives `400`; an unknown account receives `404`. The temporary password is
not persisted or logged in plaintext.

## ACC-12 — account deactivation Stage 1

```bash
curl -i -b cookies.txt -X DELETE \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}' \
  http://localhost:3000/api/auth/account
```

Expected: `200`, refresh cookie cleared, `isActive` false, deactivation date
set, and refresh sessions revoked. Missing/false confirmation is `400`.
Subsequent authenticated requests and login are rejected.

## ACC-12 Stage 2 — booking integration status

Stage 2 is **pending and not implemented**. The official requirement files
(`docs/requirements/api-requirements.md` and
`docs/requirements/requirements-tracking.md`) are currently empty. In
addition, all Flight Booking and Hotel Booking schemas, services, controllers,
DTOs, and status enums are zero-byte scaffolds. The repository therefore does
not define:

- the booking-to-user reference;
- confirmed or cancellable status values;
- flight departure or hotel stay date fields;
- the definition of an upcoming booking;
- whether deactivation must be blocked or whether bookings must be cancelled;
- the booking service cancellation contract or transaction boundary.

No booking modules were modified and no booking logic was invented. Before
implementation, the booking developers must provide the real schemas and
services plus this integration contract:

1. `findUpcomingConfirmedByUser(userId)` for both booking types, using the
   module's canonical status and date fields.
2. The exact ACC-12 behavior when matches exist: block deactivation or invoke
   cancellation.
3. An idempotent cancellation method if cancellation is required.
4. Safe behavior for missing booking references and database failures.
5. Transaction/compensation expectations across user deactivation and both
   booking collections.

Once supplied, runtime test commands should include:

```bash
# Confirmed upcoming flight booking: expected ACC-12 behavior per official rule
curl -i -b cookies.txt -X DELETE \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}' \
  http://localhost:3000/api/auth/account

# Confirmed upcoming hotel booking: expected ACC-12 behavior per official rule
curl -i -b cookies.txt -X DELETE \
  -H 'Content-Type: application/json' \
  -d '{"confirm":true}' \
  http://localhost:3000/api/auth/account
```

These Stage 2 commands are **not runtime-tested** and their expected status
cannot be claimed until the official rule and booking contracts are present.

## Profile management

```bash
curl -i -b cookies.txt http://localhost:3000/api/users/me
curl -i -b cookies.txt -X PATCH \
  -H 'Content-Type: application/json' \
  -d '{"name":"Updated Name","phone":"+201000000000","preferredCurrency":"USD"}' \
  http://localhost:3000/api/users/me
```

Expected: `200` with only public profile fields. Unauthenticated requests are
`401`; an empty body is `400`; role, email, password, `isActive`, suspension,
and token fields are rejected as non-whitelisted fields (`400`). The legacy
`GET /api/auth/me` and `PATCH /api/auth/profile` routes remain compatible.

## GEN-08 — media upload

```bash
curl -i -b cookies.txt -X POST \
  -F 'file=@./test-image.png;type=image/png' \
  -F 'targetType=profile' \
  http://localhost:3000/api/media
curl -i -b cookies.txt http://localhost:3000/api/media/<MEDIA_ID>/content
```

Expected: upload `201`/`200` with media ID and API URL; content `200` with the
image bytes. Missing file, unsupported/mismatched extension or MIME type,
zero-byte files, malformed signatures, and files over 5 MB are `400`.
Multer rejects more than one file and oversized multipart payloads. An
inactive, suspended, or deactivated uploader is rejected. Unauthenticated
requests are `401`; another user's profile media is `404`. Filenames
containing path separators are sanitized and no storage path/key is returned.
A metadata database failure must remove the stored file; if cleanup itself
fails, the database error remains the response cause and cleanup is logged
without a path. Images with valid signatures but truncated/corrupt encoded
data are rejected by full decoding. No dimension or total-pixel limit is
applied because GEN-08 specifies only format and file-size limits.
POST and COMMENT uploads now require an existing owner-authorized target;
post media is limited to five images. Published post and comment media under a
published post can be fetched publicly; drafts, hidden posts, deleted content,
and non-visible comments are not public. ITINERARY uploads still return `501`
because itinerary activity media ownership/count rules are not implemented.
The five-image-per-itinerary-activity limit, five-per-hotel limit, and one
airline-logo limit remain tracked separately.

```bash
# Invalid signature despite an allowed-looking name and MIME type
printf 'not-an-image' >/tmp/fake.png
curl -i -b cookies.txt -X POST \
  -F 'file=@/tmp/fake.png;type=image/png' \
  -F 'targetType=profile' \
  http://localhost:3000/api/media

# Profile target IDs are forbidden; the post target must exist and belong to the uploader
curl -i -b cookies.txt -X POST \
  -F 'file=@./test-image.png;type=image/png' \
  -F 'targetType=profile' -F 'targetId=507f1f77bcf86cd799439011' \
  http://localhost:3000/api/media
curl -i -b cookies.txt -X POST \
  -F 'file=@./test-image.png;type=image/png' \
  -F 'targetType=post' -F 'targetId=507f1f77bcf86cd799439011' \
  http://localhost:3000/api/media
```

Expected: profile target ID is `400`; post media succeeds only for an owned
post and is limited to five images. Itinerary target uploads remain `501`.
These commands are documented cases and were not run manually for this task.

```bash
# Valid header but truncated JPEG
printf '\\377\\330\\377\\340' >/tmp/truncated.jpg
curl -i -b cookies.txt -X POST \
  -F 'file=@/tmp/truncated.jpg;type=image/jpeg' \
  -F 'targetType=profile' \
  http://localhost:3000/api/media

# Multiple files and a file larger than 5 MB
curl -i -b cookies.txt -X POST \
  -F 'file=@./test-image.png;type=image/png' \
  -F 'file=@./test-image.png;type=image/png' \
  -F 'targetType=profile' \
  http://localhost:3000/api/media
dd if=/dev/zero of=/tmp/oversized.png bs=1m count=6
curl -i -b cookies.txt -X POST \
  -F 'file=@/tmp/oversized.png;type=image/png' \
  -F 'targetType=profile' \
  http://localhost:3000/api/media
```

Expected: truncated/corrupt content is `400`; multiple files and payloads
larger than 5 MB are rejected by Multer before the controller receives a
complete file. Runtime execution remains pending.

## GEN-09 — report submission

```bash
curl -i -b cookies.txt -X POST \
  -H 'Content-Type: application/json' \
  -d '{"targetType":"post","targetId":"<POST_ID>","reason":"Spam"}' \
  http://localhost:3000/api/reports
```

Expected: `201`/`200` and status `open`. The same reporter cannot submit the
same target twice (`409`). Invalid target type/ID or missing reason is `400`;
unauthenticated requests are `401`. Moderation remains outside this endpoint.

## FX rates

```bash
curl -i -b cookies.txt \
  'http://localhost:3000/api/fx-rates/rate?from=USD&to=EGP'
curl -i -b cookies.txt \
  'http://localhost:3000/api/fx-rates/convert?from=USD&to=EGP&amount=100'
```

Expected: `200` with rate/conversion and `stale: false` for fresh provider
data. Invalid three-letter codes or non-positive amounts are `400`. Provider
failure returns a bounded stale cached result for the same base/target pair
when available; otherwise `503`. A malformed provider response or non-finite
rate is rejected. Provider failure responses do not expose upstream URLs,
credentials, or exception details. Overflowing conversions are rejected
instead of returning `Infinity`. The obsolete `base` query property is not
accepted.
Configure `FXRATES_API_KEY`, `FXRATES_BASE_URL`,
`FXRATES_CACHE_TTL_MS`, and `FXRATES_STALE_TTL_MS`; the stale TTL must be
greater than or equal to the cache TTL.

```bash
# Normalized currency codes and conversion
curl -i \
  'http://localhost:3000/api/fx-rates/rate?from=%20usd%20&to=egp'
curl -i \
  'http://localhost:3000/api/fx-rates/convert?from=USD&to=EGP&amount=100'

# Invalid values
curl -i \
  'http://localhost:3000/api/fx-rates/rate?from=US&to=EGP'
curl -i \
  'http://localhost:3000/api/fx-rates/convert?from=USD&to=EGP&amount=-1'
curl -i \
  'http://localhost:3000/api/fx-rates/convert?from=USD&to=EGP&amount=Infinity'
curl -i \
  'http://localhost:3000/api/fx-rates/convert?from=USD&to=EGP&amount=100&base=EUR'
```

Expected: surrounding whitespace is normalized; invalid codes, negative or
non-finite amounts, and the obsolete `base` property are rejected with `400`.
These commands require a configured provider and were not runtime-tested.

## Database seed

```bash
MONGODB_URI='mongodb://localhost:27017/travel_planning' \
NODE_ENV=development \
SEED_ADMIN_EMAIL='admin@example.local' \
SEED_ADMIN_PASSWORD='<local-development-password>' \
SEED_MODERATOR_EMAIL='moderator@example.local' \
SEED_MODERATOR_PASSWORD='<local-development-password>' \
SEED_USER_EMAIL='user@example.local' \
SEED_USER_PASSWORD='<local-development-password>' \
npm run seed
```

Expected: three accounts with the existing `admin`, `moderator`, and `user`
roles are ensured without deleting or duplicating existing records. Existing
records are not overwritten, including manually changed passwords, names,
roles, or status fields. Passwords are required through environment variables
and hashed with bcrypt before insertion; no seed password fallback exists in
source code.

```bash
# Production is explicitly rejected before connecting to MongoDB
NODE_ENV=production npm run seed

# Test environment is allowed, but all required variables are still required
NODE_ENV=test \
MONGODB_URI='mongodb://localhost:27017/travel_planning_test' \
SEED_ADMIN_EMAIL='admin@example.local' \
SEED_ADMIN_PASSWORD='<local-test-password>' \
SEED_MODERATOR_EMAIL='moderator@example.local' \
SEED_MODERATOR_PASSWORD='<local-test-password>' \
SEED_USER_EMAIL='user@example.local' \
SEED_USER_PASSWORD='<local-test-password>' \
npm run seed
```

Expected: production exits non-zero with no database connection attempt.
Missing `MONGODB_URI` or any `SEED_*` value exits non-zero with a clear
configuration error. Re-running the development/test command is idempotent.
Runtime MongoDB tests were not performed.

## Final integration audit status

- **Authentication:** authenticated routes use the global JWT guard;
  deactivated, suspended, inactive, and idle accounts are rejected. Access
  and refresh token lifetimes now use `JWT_EXPIRES_IN` and
  `REFRESH_TOKEN_EXPIRES_IN`.
- **Administration / ACC-07a:** admin-only reset remains role-protected,
  validates account IDs, limits reset targets to user/moderator accounts, and
  revokes existing sessions.
- **ACC-12 Stage 2:** blocked. Flight Booking and Hotel Booking schemas,
  services, controllers, statuses, dates, and ownership contracts remain
  empty, and the official requirement files contain no ACC-12 rule.
- **Profiles:** only name, phone, and preferred currency are writable;
  public responses omit password and token fields.
- **GEN-08:** profile uploads are authenticated, private, owner-scoped,
  Multer-limited to one 5 MB file, restricted to genuine JPG/PNG files,
  signature/decode validated, and cleaned up after metadata failures.
  Dimension and total-pixel restrictions are not applied because they are not
  part of the official GEN-08 requirement. Non-profile targets remain pending
  ownership/count/visibility contracts.
- **GEN-09:** duplicate reporter/target submissions are prevented by the
  unique index. Target existence cannot be checked until target modules expose
  their schemas/services.
- **FX rates:** currency/rate/provider response validation, pair-specific
  caching, bounded stale fallback, timeout handling, conversion overflow
  handling, and configuration validation are present.
- **Swagger:** the application exposes Swagger at `/docs` with the `/api`
  global prefix. Assigned controllers now have tags, operation descriptions,
  response statuses, parameters, request bodies, DTO property metadata, and
  cookie-based authentication documentation. Media upload is documented as
  multipart/form-data with a binary file and a 5 MB limit. ACC-12 Stage 2
  booking integration and non-profile media targets remain explicitly
  pending, rather than being documented as implemented.
- **Runtime status:** build and lint results are reported by the audit run;
  MongoDB, provider, and endpoint runtime tests remain pending.

## Swagger verification

Start the backend with the required environment variables, then open:

```text
http://localhost:3000/docs
```

The documented routes use the `/api` prefix. Authenticate through
`POST /api/auth/login`; the server sets the HTTP-only `access_token` cookie.
Use Swagger's cookie-authenticated operations after login. Public operations
are registration, login, refresh, logout, and FX rate/convert requests.

Documentation checks:

- Confirm Authentication, Administration, User Profiles, Media, Reports, and
  FX Rates tags are visible.
- Confirm protected operations show the `access_token` cookie security scheme.
- Confirm `POST /api/media` shows multipart/form-data, a binary `file`, and
  `targetType`.
- Confirm DTO examples do not contain passwords, tokens, secrets, or storage
  paths.

These are documentation/UI checks only. Runtime API and MongoDB tests remain
pending and were not claimed as passed.

## GEN-08 strict requirement verification

Automated unit coverage is present in
`src/modules/media/media.service.spec.ts` for genuine JPG/PNG acceptance,
WebP and unsupported-format rejection, extension/MIME mismatch, corrupted
images, and files over 5 MB. The tests do not require MongoDB.

The official count limits cannot yet be implemented safely:

- Post ownership and media-count service contract: **BLOCKED**
- Itinerary activity ownership and media-count service contract: **BLOCKED**
- Hotel ownership and media-count service contract: **BLOCKED**
- Airline logo ownership and logo-count service contract: **BLOCKED**

The corresponding modules currently provide no implemented schemas or service
contracts that the media module can query. No invented fields or integrations
were added. Once those contracts exist, runtime/integration tests must verify
five-image and one-logo boundary behavior.
