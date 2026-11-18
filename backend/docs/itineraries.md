# Itinerary planning and budgets

## Requirements and implementation choices

The repository did not contain the official GIU project description or requirements workbook when this milestone was implemented. Its local requirements summaries were empty. This implementation follows the supplied task and existing itinerary schemas, with conservative choices documented here:

- Itineraries are private by default. Owner routes are scoped to the authenticated owner. An itinerary can be made public (`visibility: public`); only then is it listed by `GET /api/itineraries/public/search`, readable at `GET /api/itineraries/public/:id` (without budgets, bookings or owner details) and cloneable by others. A private itinerary is 404 for everyone else.
- An itinerary can contain at most 60 days, with or without an `endDate`. Days are created in order, numbered sequentially, and require a city. A day's **date is derived** (`startDate + dayNumber - 1`), never stored or accepted; `cityGroups` (runs of consecutive days in one city) are computed on read.
- Only bookings owned by the current user and not cancelled or expired can be linked. Booking documents remain authoritative; linking does not copy or modify a booking.
- A budget entry is either `planned` or `actual`, belongs to a day, and keeps its original amount and currency. Transport costs count toward planned totals. Flight/hotel booking prices and activity costs are not counted because their inclusion rules and currencies are unspecified. The summary also returns a per-bucket `breakdown` (food, accommodation, in_city_transport, activities, intercity_transport, each planned and actual), `grandTotal`, the `exchangeRates` used and `ratesAsOf`.
- The itinerary's `displayCurrency` is the default for totals. A `currency` query parameter can request a different display currency. Conversion uses the existing `FxRatesService`; conversion failure is returned as the FX module's service error rather than producing a misleading total.

## API

All endpoints require the existing authenticated `access_token` cookie. The API global prefix is `/api`.

| Method             | Route                                                      | Purpose                                                                                           |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `POST`             | `/api/itineraries`                                         | Create an itinerary with title, country IDs, start date, optional end date, and display currency. |
| `GET`              | `/api/itineraries`                                         | List the current user's itineraries; optional `?currency=EGP`.                                    |
| `GET`              | `/api/itineraries/:id`                                     | Get details and per-entry/summary budget amounts; optional `?currency=EGP`.                       |
| `PATCH`            | `/api/itineraries/:id`                                     | Update itinerary fields and display currency.                                                     |
| `DELETE`           | `/api/itineraries/:id`                                     | Delete an owned itinerary; bookings are not changed.                                              |
| `POST`             | `/api/itineraries/:id/days`                                | Append an ordered day with a city and optional notes.                                             |
| `PATCH`            | `/api/itineraries/:id/days/order`                          | Reorder all days by supplying the complete `dayIds` array.                                        |
| `PATCH` / `DELETE` | `/api/itineraries/:id/days/:dayId`                         | Update or remove a day; subsequent day numbers are compacted after removal.                       |
| `POST`             | `/api/itineraries/:id/days/:dayId/activities`              | Append an activity to a day.                                                                      |
| `PATCH` / `DELETE` | `/api/itineraries/:id/days/:dayId/activities/:activityId`  | Update or remove an activity.                                                                     |
| `POST`             | `/api/itineraries/:id/days/:dayId/budget-entries`          | Add a planned or actual expense with its own currency.                                            |
| `PATCH` / `DELETE` | `/api/itineraries/:id/days/:dayId/budget-entries/:entryId` | Update or remove an expense.                                                                      |
| `POST`             | `/api/itineraries/:id/transport-costs`                     | Add a travel segment and its cost/currency to an itinerary day.                                   |
| `PATCH` / `DELETE` | `/api/itineraries/:id/transport-costs/:costId`             | Update or remove a travel segment.                                                                |
| `GET`              | `/api/itineraries/public/search`                           | Public itineraries (no sign-in): filters `city`, `country`, `from`, `to`; paged.                  |
| `GET`              | `/api/itineraries/public/:id`                              | A public itinerary without budgets, bookings or owner details.                                    |
| `POST`             | `/api/itineraries/:id/clone`                               | Copy a public (or your own) itinerary into a new private one with `clonedFrom`.                   |
| `GET`              | `/api/itineraries/:id/hotels`                              | Hotel search for a city group of your itinerary (reuses `GET /hotels/search`).                    |
| `GET`              | `/api/itineraries/:id/flights`                             | Flight search into a city group of your itinerary (reuses `GET /flights/search`).                 |
| `GET`              | `/api/itineraries/:id/budget-summary`                      | Planned/actual totals, per-bucket breakdown, grand total and the exchange rates used.             |
| `POST` / `DELETE`  | `/api/activities/:id/images`, `/api/activities/:id/images/:imageId` | JPG/PNG up to 5 MB, at most 5 per activity; owner only (404 otherwise).        |
| `POST`             | `/api/itineraries/:id/bookings`                            | Link owned booking IDs using `hotelBookingIds` and/or `flightBookingIds` arrays.                  |
| `DELETE`           | `/api/itineraries/:id/bookings/:bookingId`                 | Remove a booking association without changing the booking.                                        |

Budget summaries return `plannedTotal` and `actualTotal` in the selected display currency. Each budget entry and transport cost also returns `displayAmount` and `displayCurrency`; original `amount` and `currency` remain stored and returned.
Itinerary responses include `linkedBookings` with current booking statuses, dates, references, and original totals, so status changes in the booking modules are reflected without copying booking state into an itinerary.

## Example requests

Create:

```json
{
  "title": "Cairo visit",
  "countryIds": ["507f1f77bcf86cd799439011"],
  "startDate": "2026-12-01",
  "endDate": "2026-12-05",
  "displayCurrency": "EGP"
}
```

Add an actual expense to a day:

```json
{
  "description": "Museum tickets",
  "category": "activities",
  "amount": 12.5,
  "currency": "EUR",
  "type": "actual",
  "incurredAt": "2026-12-02T10:00:00.000Z"
}
```

Link bookings:

```json
{
  "hotelBookingIds": ["507f1f77bcf86cd799439011"],
  "flightBookingIds": ["507f1f77bcf86cd799439012"]
}
```
