# Manual tests vs automated tests

Source: the "Manual tests" sheet exported on 2026-11-18 (144 rows). For each manual test, this file names the automated test that checks the same behaviour.

How to read it:
- **full**: an automated test checks the behaviour end to end as the manual test describes it.
- **partial**: some of the behaviour is checked automatically, or only below the HTTP layer; the gap is named.
- **none**: no automated test.
- Files are shown short. `X.e2e.ts` is `test/e2e/X.e2e.ts`, `X.integration.ts` is `test/integration/X.integration.ts`, and a `.spec.ts` file is a unit test under `src/`.
- No code was changed to make this list. The mapping was done by reading the test names and, where unclear, the test bodies. The tests were not re-run for this document.

| Manual # | Covered by (file and test name) | Coverage |
|---|---|---|
| 1 | Not one test. The same setup is built through the API in many e2e tests (e.g. admin.e2e "creates a hotel moderator for an active hotel…", hotel-search.e2e room tests, payments.e2e cabin tests) and by demo-seed.integration "creates the demo data…". Starting the server and opening Swagger is not tested as a flow. | partial |
| 2 | reference.e2e "seeding twice is idempotent: nothing inserted or updated the second time, same row counts"; reference-import.spec.ts | full |
| 3 | reference.e2e "GET /api/airports returns iata_code, name, city, country and time_zone" | full |
| 4 | reference.e2e "GET /api/currencies lists each supported currency once" | full |
| 5 | reference.e2e "a hotel in an unknown city is rejected" | full |
| 6 | reference.e2e "a hotel whose city is not in its country is rejected" | full |
| 7 | reference.e2e "a flight from or to an unknown airport is rejected" | full |
| 8 | reference.e2e "an itinerary with an unknown country is rejected" and "…an unsupported display currency is rejected" | full |
| 9 | auth.e2e registration `it.each` (bad passwords, acceptTerms) and "validation errors use the { message, errors: [{ field, messages }] } shape" | full |
| 10 | auth.e2e "registration returns no token and no password hash" (201, no token). The httpOnly cookies are asserted on login ("login sets httpOnly cookies and puts no token in the body"), not on register. | partial |
| 11 | auth.e2e "a duplicate email gives 409 with a field-level error, case-insensitively"; auth.integration "two simultaneous registrations of the same email" | full |
| 12 | auth.e2e "5 wrong passwords give 401 four times and then 423 with lockedUntil" | full |
| 13 | auth.e2e "the correct password while locked is still 423" | full |
| 14 | auth.e2e "a successful login resets the failure counter" | full |
| 15 | auth.e2e "an unknown email gets the same generic message as a wrong password" | full |
| 16 | auth.e2e "a suspended user with a wrong password gets the generic message, with the right one "suspended""; admin.e2e "suspending revokes the session and blocks login…" | full |
| 17 | admin.e2e "suspending revokes the session and blocks login; reactivating restores access" | full |
| 18 | auth.e2e "/auth/me returns the profile with a cookie and 401 without one" | full |
| 19 | auth.e2e change-password `it.each` and "change-password via PATCH/POST rejects a wrong current password (401) and a weak new one (400)" | full |
| 20 | auth.e2e "logout clears the session…" and "a refresh cookie captured before logout fails after logout" | full |
| 21 | auth.e2e "an admin password reset forces a change: users/me 403, auth/me ok, change-password ok" | full |
| 22 | auth.e2e "a session idle for more than 30 minutes expires (ACC-06)" and "activity within the window keeps the session alive"; auth.integration "refresh rotation, replay rejection, logout revocation and idle expiry" | full |
| 23 | users.e2e "updates name, phone and a supported preferred currency" and "an invalid currency is rejected (400)" | full |
| 24 | users.e2e DELETE /users/me `it.each` (no body, confirm false, string "true", string "false") | full |
| 25 | users.e2e "is blocked by an upcoming Confirmed hotel booking (409)" and "…flight booking (409)"; auth.integration ACC-12 tests | full |
| 26 | users.e2e "succeeds: ends the session, blocks login, hides posts, makes itineraries private and shows "Deleted user""; auth.integration "after deactivation: cannot log in, posts hidden, public itineraries private" | full |
| 27 | admin.e2e "defaults to 10 per page and pages through the rest" and "rows carry name, email, role, status and registration date, and no secrets" | full |
| 28 | admin.e2e "filters by role, status and search together"; auth.integration "combines search, role AND status filters with a page size of 10" | full |
| 29 | admin.e2e "rejects an inactive provider (409), then accepts it once reactivated" and "…the moderator must change the temporary password" | full |
| 30 | admin.e2e "suspending revokes the session…", "notifies users with upcoming bookings, and only them", "notifies flight passengers when an airline is deactivated"; refunds-cancellation.e2e "suspending and reactivating an account notifies that user" | full |
| 31 | admin.e2e GET /admin/bookings group: "lists flight and hotel bookings…", "filters by type, status and user", "dateField=booked…", "paginates 10 at a time by default"; auth.integration "ACC-17 admin booking list" | full |
| 32 | holds.e2e "a hotel hold is Pending Payment and expires in 10 minutes" | full |
| 33 | holds.e2e "a flight hold is Pending Payment, expires in 10 minutes and takes the seats" | full |
| 34 | holds.e2e "an overlapping hold on the same room gives 409" | full |
| 35 | holds.e2e "a 3-room booking with one room already held holds nothing"; booking-concurrency.integration "multi-room: if one of three rooms is unavailable, none are held" | full |
| 36 | holds.e2e "two REAL concurrent requests for the same room give exactly one 201 and one 409"; booking-concurrency.integration "two simultaneous holds for the same room and dates: exactly one succeeds" | full |
| 37 | holds.e2e "invalid dates give 400" (equal, before, past, malformed) | full |
| 38 | holds.e2e "cancelling an unpaid hold gives Expired and frees the room"; aliases.e2e "POST /hotel-bookings/:id/cancel returns the same as DELETE (unpaid hold)" | full |
| 39 | holds.e2e "blocking a range over a held range is rejected"; hotel-search.e2e "blocking is rejected over a Confirmed reservation or an unexpired hold (409) and accepted elsewhere" | full |
| 40 | holds.e2e "cancelling a Cancelled booking again is rejected (409) and never creates a second refund" | full |
| 41 | aliases.e2e "POST /flight-bookings/:id/cancel returns the same as DELETE" and "POST /hotel-bookings/:id/cancel returns the same as DELETE" | full |
| 42 | aliases.e2e "PATCH /itineraries/:id/days/reorder returns the same as /days/order" | full |
| 43 | aliases.e2e PATCH/DELETE /activities, /budgets, /transport-costs tests and "another user's id gives 404 and changes nothing" | full |
| 44 | aliases.e2e "GET /itineraries/:id/budget-summary equals the budgetSummary of GET /itineraries/:id" | full |
| 45 | aliases.e2e "GET /refunds/:id is 404 while no refund exists and 200 once a confirmed booking is cancelled" | full |
| 46 | aliases.e2e "PUT /hotels/:id/policies returns the same as PATCH /hotels/:id" and "…rejects fields outside the policy (400)" | full |
| 47 | aliases.e2e "GET /hotels/:id/availability is moderator-only: customer 403, admin 403, anonymous 401, other hotel 403…" | full |
| 48 | aliases.e2e "webhook … with a bad signature gives 400 and changes nothing"; payments.e2e "an invalid signature is 400 and changes nothing" | full |
| 49 | aliases.e2e "both flight hold routes carry the "creating the booking IS the hold" warning" | full |
| 50 | The unit and e2e suites themselves (`npm test`). Nothing tests that the command is run. | full |
| 51 | The integration suites themselves (`npm run test:integration`). | full |
| 52 | No test. `npm run build` (tsc) is a compile check, not a test. | none |
| 53 | flight-search.e2e "GET /flights/search needs no login and returns airline, airports, local and UTC times, duration, cabins and baggage" (duration 240 min) | full |
| 54 | flight-search.e2e "the estimated total is (adults + children) x fare + infants x 10% of the fare"; "infants take no seat…" | full |
| 55 | flight-search.e2e "more infants than adults is 400 on infants" and "no adult is 400 on adults" | full |
| 56 | flight-search.e2e "minPrice greater than maxPrice is 400", "an unknown airport is 400 on that field", "the same origin and destination is 400", past-date test ""past" is judged by today's date at the ORIGIN airport" | full |
| 57 | flight-search.e2e "cabinClass keeps only flights with that class…" and "no match is a 200 with an empty list and "No flights found"" | full |
| 58 | flight-search.e2e "sorts by price, duration and departure time, ascending and descending" | full |
| 59 | flight-search.e2e "returns outbound and return option lists…" and "a return flight must depart after the outbound arrival" | full |
| 60 | flight-search.e2e "pages of 10 by default, then the rest" | full |
| 61 | flight-search.e2e "a guest sees airline, airports, local and UTC times, duration and every cabin with price, seats and baggage" and "includes the airline's cancellation policy and baggage policy, and null when they are not set" | full |
| 62 | flight-search.e2e "a deactivated airline is hidden, and visible again once reactivated" | full |
| 63 | reference.e2e "airports: a well-formed but unknown countryCode or cityId is an empty 200", "airports: a malformed countryCode or cityId is 400 on that field", "/api/airports: a bad page or limit is 400 on that field" | full |
| 64 | holds.e2e "holding more seats than are left gives 409" reads `GET /flights/:id/cabins` without a login, but no test is about that route being public. payments.e2e cabin tests read it as a moderator. | partial |
| 65 | hotel-search.e2e "a guest finds an active hotel with a free room and sees the summary" | full |
| 66 | hotel-search.e2e validation group: "both city and country is 400", "neither city nor country is 400", "check-out must be after check-in", "check-in cannot be in the past", "an unknown query parameter is 400" | full |
| 67 | hotel-search.e2e "an unknown (but well-formed) city or country is an empty 200 with "No hotels found"" | full |
| 68 | hotel-search.e2e "the best `rooms` rooms by occupancy together must hold all the guests" | full |
| 69 | hotel-search.e2e "an unexpired hold excludes the room; an EXPIRED hold does not" and "search and booking use the same rule" | full |
| 70 | hotel-search.e2e "Cancelled and Expired reservations do not exclude a room"; holds.e2e "cancelling an unpaid hold gives Expired and frees the room" | full |
| 71 | hotel-search.e2e "minPrice greater than maxPrice is 400; equal is fine", "the price filter uses the cheapest FREE room…", "sorts by price… ascending and descending" | full |
| 72 | hotel-search.e2e "minRating excludes unrated hotels and hotels below it, inclusively" | full |
| 73 | hotel-search.e2e "a guest sees every free room with type, beds, occupancy, price per night and the total stay price" | full |
| 74 | hotel-search.e2e "each room is Available, Booked (with the reservation reference) or Blocked" | full |
| 75 | hotel-search.e2e "ranges that touch count as one…" and "a real gap between ranges, even one night, makes the room not free" | full |
| 76 | hotel-search.e2e deleting a room with a CONFIRMED / CANCELLED / EXPIRED booking is 409; "a room that was never reserved can be deleted" | full |
| 77 | payments.e2e "GET returns the hotel cancellation tiers and check-in/check-out times" and "GET returns the flight cancellation and baggage policies, snapshotted at booking time" | full |
| 78 | payments.e2e "payment is blocked (409) until the hotel/flight policies are accepted, then allowed" | full |
| 79 | payments.e2e "accept-policies body … is 400" (incl. string "true") and "acceptance is stored with a timestamp and a second call keeps the first one" | full |
| 80 | payments.e2e "another user's booking is 404 for policies, acceptance and payment" | full |
| 81 | payments.e2e "returns paymentId, clientSecret, amount and currency, taken from the booking" and "asking again returns the same open PaymentIntent, not a second payment" | full |
| 82 | payments.e2e "pays with pm_card_visa but does NOT confirm the booking; only the signed webhook does" and "payment_intent.succeeded confirms a hotel booking…" (Stripe is faked) | full |
| 83 | payments.e2e "{ outcome: "decline" } uses pm_card_chargeDeclined and reports a decline (200), then retry works"; "a failed attempt marks the payment Failed and keeps the booking Pending Payment" | full |
| 84 | payments.e2e retry group: "reuses the same PaymentIntent while Stripe says it is still usable, and the booking can then be paid" | full |
| 85 | payments.e2e "is rejected (409) once the hold expired" (retry) and "the expiry job cancels the open PaymentIntent and the payment becomes Expired" | full |
| 86 | payments.e2e "a room in another currency is 400 on the currency field…", "a room without a currency gets the platform currency…", "a cabin in another currency is 400…; without one it gets the platform currency" | full |
| 87 | payments.e2e "updating a cabin to another currency is 400" also does `PATCH /flights/:id/cabins/:cabinId` and expects 200 for the platform currency. No test changes a cabin's price through that route, so the old 500 on a price change is not pinned. | partial |
| 88 | refunds-cancellation.e2e "cancelling a Confirmed booking creates exactly one refund on the original PaymentIntent, for the tier share" and "a refund Stripe accepted as pending becomes Refunded by the signed webhook" (a real Stripe dashboard refund is not checked) | full |
| 89 | refunds-cancellation.e2e "GET /refunds/:id: owner and admin only (others 404), 401 signed out, 400 for a bad id" | full |
| 90 | refunds-cancellation.e2e "cancelling twice is 409 and never creates a second refund"; holds.e2e "cancelling a Cancelled flight booking again is rejected (409)…" | full |
| 91 | refunds-cancellation.e2e "a 0% tier cancels the booking but creates no refund and calls Stripe for nothing" and "a 0% cancel notifies the cancellation and no refund" | full |
| 92 | refunds-cancellation.e2e "a partial tier refunds that share of what was paid (Partially Refunded)" checks the payment status. No test checks that `refundId` on the payment equals the id that works on `GET /refunds/:id`; refund-state.spec.ts covers state rules only. | partial |
| 93 | refunds-cancellation.e2e "cancels the flight, refunds every Confirmed booking 100%, expires holds and leaves Completed ones alone"; "seats of the cancelled bookings and holds are released"; flight-cancellation.integration (atomic) | full |
| 94 | refunds-cancellation.e2e "a cancelled flight disappears from search and cannot be booked" | full |
| 95 | refunds-cancellation.e2e "cancelling again is 409 and creates no second refund" and "only the airline's moderator or an admin may cancel; others are 403 and change nothing" | full |
| 96 | refunds-cancellation.e2e "a customer cancel notifies: booking cancelled, refund started, refund completed (newest first)", "lists 10 per page by default, newest first…", "a cancelled flight notifies every affected booking, and nobody else" | full |
| 97 | refunds-cancellation.e2e "mark one read, mark all read, and only for your own notifications" | full |
| 98 | refunds-cancellation.e2e "a new departure or arrival time notifies Confirmed bookings only; other edits notify nobody" | full |
| 99 | refunds-cancellation.e2e "suspending and reactivating an account notifies that user" | full |
| 100 | refunds-cancellation.e2e "the owner downloads a PDF attachment for a Confirmed booking"; e-ticket.document.spec.ts (PDF content) | full |
| 101 | refunds-cancellation.e2e "is 409 for a booking that is Pending Payment, Expired or Cancelled", "another user's booking and a hotel booking are 404; signed out is 401; a bad id is 400", "a Completed booking still has its ticket, and an admin may download any" | full |
| 102 | provider-views-reviews.e2e "%s returns 10 by default, accepts limit=100 and rejects limit=101, 0 and page=0" (includes /api/admin/audit-logs); audit-logs.service.spec.ts. `limit=abc` itself is covered by the same strict-pagination pipe tests (validation.pipe.spec.ts). | full |
| 103 | provider-views-reviews.e2e "flight bookings: upcoming, past and cancelled hold exactly the right bookings (own only)"; booking-groups.spec.ts | full |
| 104 | provider-views-reviews.e2e "hotel bookings: a stay in progress is upcoming; a stay whose check-out day is over is past" | full |
| 105 | provider-views-reviews.e2e "GET /flight-bookings/:id/e-ticket behaves exactly like GET /bookings/:id/e-ticket" | full |
| 106 | provider-views-reviews.e2e "lists one row per booking with passengers, cabin, counts by type and booked-at, plus seats left per cabin" and "bookings: another airline's moderator, a hotel moderator and a user get 403…" | full |
| 107 | provider-views-reviews.e2e "exports Confirmed and Completed passengers as a CSV attachment, with injection-safe cells"; csv.spec.ts | full |
| 108 | provider-views-reviews.e2e hotel reservations group: "lists the hotel's reservations newest first with guest, rooms, dates, status, total and reference" and "only that hotel's moderator or an admin: others 403…" | full |
| 109 | provider-views-reviews.e2e "only a Completed stay can be reviewed, by its owner" | full |
| 110 | provider-views-reviews.e2e "one review per reservation: a second is 409 and nothing is counted twice" | full |
| 111 | provider-views-reviews.e2e review validation `it.each` (rating out of range, unknown field) | full |
| 112 | provider-views-reviews.e2e "public list: newest first, 10 per page, average and count, "Deleted user" for deactivated authors, hidden left out" | full |
| 113 | provider-views-reviews.e2e "the stored average and count follow every create, edit and delete; the last delete makes the hotel unrated" | full |
| 114 | provider-views-reviews.e2e "edit: author only (others 404)… delete: author or admin (others 404)" | full |
| 115 | round-trip-booking.e2e "derives adult / child / infant from the date of birth on the departure day…"; flight-search.e2e cabins carry an `id` in details and search | full |
| 116 | round-trip-booking.e2e "passport or national ID: exactly one, valid formats, passport expiry after arrival, known nationality"; booking-rules.spec.ts "requires exactly one of passport or national ID" | full |
| 117 | round-trip-booking.e2e "derives adult / child / infant… the infant takes no seat and pays 10%" | full |
| 118 | round-trip-booking.e2e "a booking whose passengers are all infants needs no seat but is rejected: at least one adult" (also covers a child with no adult and more infants than adults); booking-rules.spec.ts "needs at least one adult, no more infants than adults…" | full |
| 119 | round-trip-booking.e2e "extra bags are charged per bag on top of the fare…" and "more than the maximum per passenger is 400 on that passenger…" | full |
| 120 | round-trip-booking.e2e "the baggage policy price must be in the platform currency: omitted means EGP, another currency is 400" (the test platform currency is EGP) | full |
| 121 | round-trip-booking.e2e "one booking, one reference, one payment, two segments; each segment priced at its own cabin; the worked example"; round-trip-hold.integration "holds seats on both flights and creates one booking" | full |
| 122 | round-trip-booking.e2e "rejects a return that departs before (or exactly at) the outbound arrival: 409…" and "rejects a return that is not the reverse route (400)" | full |
| 123 | round-trip-booking.e2e "a seat shortage on EITHER flight is 409 and holds nothing on both"; round-trip-hold.integration "a seat shortage on the RETURN rolls back the outbound hold: nothing is held" | full |
| 124 | round-trip-booking.e2e "one booking… one payment…" and "the e-ticket (both paths) shows both flights"; payments.e2e flight webhook confirmation | full |
| 125 | round-trip-booking.e2e "cancelling EITHER flight (FLT-06) cancels the whole round trip with a 100% refund and frees both flights" | full |
| 126 | round-trip-booking.e2e "copies the new departure onto Pending and Confirmed bookings, but not onto final ones" and "rescheduling: copies follow the return flight; a return before the outbound arrival, or new airports, are 409" | full |
| 127 | round-trip-booking.e2e "a round trip is listed on BOTH flights with that flight's cabin, documents, nationality and bags" | full |
| 128 | flight-search.e2e "GET /flights/search needs no login and returns…" (cabin `id: expect.any(String)`); round-trip-booking.e2e uses `cabinId` from the search cabin | full |
| 129 | itineraries-public-budget.e2e "a day date is derived from startDate + day order; nothing is stored and a date in the request is rejected" | full |
| 130 | itineraries-public-budget.e2e "delete, reorder and a new startDate keep dates and numbering consistent" and "cityGroups are runs of the same city in day order…" | full |
| 131 | itineraries-public-budget.e2e "at most 60 days, with or without an endDate; a range over 60 days is 400"; itinerary-days.spec.ts | full |
| 132 | itineraries-public-budget.e2e "per-bucket planned and actual totals in the display currency, the grand total, and the rates used" and "?currency= overrides the itinerary display currency…" | full |
| 133 | itineraries-public-budget.e2e "stores a PNG and a JPG; the owner sees them on the activity and can fetch the content" | full |
| 134 | itineraries-public-budget.e2e "400 for a wrong type, a fake image…", "at most 5 images per activity: the 6th is 409…", "only the owner: another user, an unknown activity…" | full |
| 135 | itineraries-public-budget.e2e "DELETE removes the file, the link and the record…" | full |
| 136 | itineraries-public-budget.e2e "lists and shows only public itineraries; a private one is 404 for everyone…", "filters by city, country and date range", "400 for a bad filter, paged 10 by default…" | full |
| 137 | itineraries-public-budget.e2e "shows no budgets, transport costs, bookings, activity costs, owner id or e-mail" and the private-is-404 test | full |
| 138 | itineraries-public-budget.e2e clone group: "copies the plan into a new PRIVATE itinerary of the caller, with attribution", "an optional startDate moves the whole clone…", "someone else's private itinerary, an unknown one and a bad id never clone…" | full |
| 139 | itineraries-public-budget.e2e "hotels: the same search as GET /hotels/search, for the city and dates of a city group" and "hotels: validation, ownership and the hotel search filters" | full |
| 140 | itineraries-public-budget.e2e "flights: the same search as GET /flights/search, into a city group from the previous one" and "flights: validation, filters and ownership" | full |
| 141 | Pieces are tested separately: cityGroups ("cityGroups are runs of the same city…"), budget breakdown in the itinerary ("?currency= overrides… the same numbers are in GET /itineraries/:id"), transport-cost PATCH/DELETE (aliases.e2e). No single test adds a transport cost and checks its mode and amount in `GET /itineraries/:id`. | partial |
| 142 | demo-seed.integration "creates the demo data, in the platform currency, and a second run creates nothing"; demo-seed.options.spec.ts. The printed table and the real CLI are not tested. | full |
| 143 | demo-seed.integration checks the 4 seeded bookings and their statuses, and that every demo user can log in. It does not call `GET /hotel-bookings` and `GET /flight-bookings` as Sara over HTTP. | partial |
| 144 | demo-seed.integration "the completed stay can be reviewed by its owner, and by nobody else" (service level); provider-views-reviews.e2e "only a Completed stay can be reviewed, by its owner" (HTTP) | full |

## Totals

| Coverage | Count |
|---|---|
| full | 136 |
| partial | 7 |
| none | 1 |
| total | 144 |

## Gaps worth closing (if wanted)

- 52: not testable as a unit; CI should run `npm run build`.
- 87: add an e2e that PATCHes a cabin's price and expects 200.
- 92: assert `payment.refundId` equals the id returned by `GET /refunds/:id`.
- 10: assert the httpOnly cookies on `POST /auth/register`.
- 64: add an anonymous `GET /flights/:id/cabins` test.
- 141: add one test that adds a transport cost and reads it back from `GET /itineraries/:id`.
- 143: add an HTTP check of Sara's two booking lists after seeding.
- 1: the setup flow is covered only in pieces.
