# Demo data seed (`npm run seed`)

The seed creates a small, consistent set of demo data so the team can run the manual tests and demo the app
without clicking through Swagger first. It is written for the **shared Atlas database**: it never changes
real data.

## Commands

Run them in `backend/`. `.env` must contain `MONGODB_URI`, and the reference data must be imported first
(`npm run seed:reference`).

| Command | What it does |
| --- | --- |
| `npm run seed -- --yes` | Creates the demo data. A second run creates nothing new. |
| `npm run seed -- --reset --yes` | Removes what an earlier run created, then creates it again with fresh dates and a fresh booking hold. |
| `SEED_CONFIRM=yes npm run seed` | Same as `--yes`, for scripts. |
| `npm run seed -- --yes --force` | Needed only when `NODE_ENV=production`. Do not do this on the real database. |
| `SEED_PASSWORD=MyPass123 npm run seed -- --yes` | Uses your own password for the demo users (at least 8 characters, one letter, one number). Default: `DemoPass123`. |

Without `--yes` the command prints the host and database name it would write to, then stops. Unknown options
(for example `--rest`) are an error, so a typo never runs a normal seed.

The old account seeder is now `npm run seed:accounts` (unchanged).

## What it creates

All prices are in the platform currency (`PLATFORM_CURRENCY`, default `USD`). Route: **CAI (Cairo) to DXB (Dubai)**.
If those airports are not in the reference data, the seed takes the first two airports that are in different cities.

| Area | Data |
| --- | --- |
| Users | `admin@demo-seed.test` (admin), `sara@demo-seed.test` and `omar@demo-seed.test` (customers), `airline-mod@demo-seed.test` (moderator of the airline), `hotel-mod@demo-seed.test` (moderator of the hotel). One shared password. The system has no e-mail verification step, so all five can log in at once. |
| Airline | "Demo Seed Air" (`DSA`): baggage policy (carry-on 7 kg, 23 kg checked, extra bag 30, at most 3 per passenger), cancellation tiers (7+ days 100%, 2+ days 50%, then 0%). |
| Flights | `DSA101` CAI to DXB in 30 days, `DSA102` DXB to CAI in 37 days (departs after the outbound lands), `DSA201` CAI to DXB in 45 days. Each has Economy (60 seats, 150) and Business (12 seats, 400). `DSA201` has no bookings: use it for the flight-cancellation and cancel-booking tests. |
| Hotel | "Demo Seed Hotel" in Dubai (4 stars, placeholder photo links, not uploaded files), rooms "Standard Double" (100 per night) and "Deluxe Suite" (250 per night), open for booking from day 5 to day 150, cancellation tiers 14+ days 100%, 3+ days 50%, then 0%. |
| Bookings of Sara | **Pending Payment** hotel booking (hold lasts 2 hours instead of 10 minutes); **Confirmed** round-trip flight booking with a Succeeded payment; **Completed** hotel stay (a past stay with a Succeeded payment), ready for a review; **Cancelled** hotel booking with a payment and a **Refunded** refund. |
| Itineraries | Public: "Cairo and Dubai in 3 days" owned by Sara (3 days, 2 cities, activities, budget entries planned and actual, one flight transport cost). Private: owned by Omar (2 days). |
| Not created | A review by Sara on the completed stay, so the review test can be done by hand. |

At the end the command prints a table with the user ids and e-mails, the password, and the ids of the airline,
hotel, rooms, flights, bookings and itineraries, to paste into Swagger. Log in with `POST /api/auth/login`.

## Safety rules

- **Marker.** The schemas are not changed. Every document the seed creates is recorded in its own collection,
  `seed_manifest` (`tag: "demo-seed-v1"`, a key, the collection and the document id). The e-mails
  (`*@demo-seed.test`), the airline code `DSA` and the names are the only fixed identifiers; they are listed in
  `src/database/seeders/demo/demo-seed.constants.ts`.
- **Idempotent.** A run looks up every document by its manifest key and creates only what is missing.
  If a real (not seeded) user already has one of the demo e-mails, or a real airline has the code `DSA`,
  the run stops before writing anything.
- **Reset.** `--reset` deletes the manifest documents and what exists only because of them: the payments,
  refunds, reviews, itineraries and notifications of the demo users, and the rooms, cabins and policies of the demo
  hotel, flights and airline. If a booking or review **of a real user** depends on the demo hotel or flights,
  the reset stops and deletes nothing. Posts, comments and uploaded files of demo users are not touched.
- **Never touches real data.** Existing users, other airlines, hotels and flights, the platform currency and
  every other setting are not read for writing. No cron job runs during the seed (so it cannot expire, complete
  or refund anyone's booking), and the hotel rating recount that normally runs when the server starts is not run.
- **Production.** `NODE_ENV=production` needs `--force`.
- **No Stripe.** The seed never calls Stripe. Its payments use ids that start with `pi_seed_` and `re_seed_`;
  they do not exist in Stripe. Do not cancel the seeded Confirmed bookings through the API with real Stripe keys:
  the refund request would fail and stay Pending. Make a new booking on `DSA201` for payment and cancellation tests.

## How the data is created

| Created through the app's services | Written directly |
| --- | --- |
| customers (`AuthService.register`), airline, both policies, flights, cabins, hotel, rooms (`AirlinesService`, `FlightsService`, `CabinInventoryService`, `HotelsService`) | the admin and the two moderators (no service creates a usable admin or moderator password) and the link from a moderator to the airline or hotel |
| all four bookings (`HotelBookingsService`, `FlightBookingsService`: holds, seats, room availability, prices, tier snapshots) | the dates and the Completed status of the past stay: the booking service refuses past dates, so a paid, Confirmed booking is moved into the past after it exists |
| payments and their Confirmed state (`PaymentsService.createPayment`, then its webhook handler with a locally made `payment_intent.succeeded` event) | |
| the cancellation and its Refunded refund (`PaymentsService.cancelBooking`, `RefundsService`) | |
| both itineraries, days, activities, budget entries and the transport cost (`ItinerariesService`) | |

## Re-running

The flights, stays and holds are dated relative to the day of the run. When they are in the past, or the pending
hold has ended, the command prints a note: run `npm run seed -- --reset --yes` to get fresh dates.

## Tests

`test/integration/demo-seed.integration.ts` (in-memory replica set, never Atlas): runs the seed twice and compares
counts, logs every demo user in, checks the completed stay can be reviewed by its owner only, and checks `--reset`
removes only seeded documents while a real user, hotel and itinerary survive. The command-line rules are unit tested
in `demo-seed.options.spec.ts`.
