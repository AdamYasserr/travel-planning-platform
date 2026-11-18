import { jest } from "@jest/globals";
import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";
import { ItinerariesService } from "./itineraries.service";
import { BudgetEntryType } from "./schemas/budget.schema";
import { ItineraryVisibility } from "./enums/itinerary-visibility.enum";
import { HotelBookingStatus } from "../hotel-bookings/schemas/hotel-booking.schema";
import { FlightBookingStatus } from "../flight-bookings/enums/flight-booking-status.enum";

describe("ItinerariesService", () => {
  const ownerId = new Types.ObjectId().toString();
  const itineraryId = new Types.ObjectId().toString();
  const hotelId = new Types.ObjectId().toString();
  const flightId = new Types.ObjectId().toString();
  let service: ItinerariesService;
  let itineraryModel: Record<string, jest.Mock>;
  let hotelModel: Record<string, jest.Mock>;
  let flightModel: Record<string, jest.Mock>;
  let fx: any;
  let references: any;
  let currencies: any;

  const doc = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(itineraryId),
    ownerId: new Types.ObjectId(ownerId),
    title: "Trip",
    countryIds: ["EG"],
    startDate: new Date("2099-01-01T00:00:00.000Z"),
    endDate: null,
    days: [],
    transportCosts: [],
    visibility: ItineraryVisibility.PRIVATE,
    displayCurrency: "USD",
    hotelBookingIds: [],
    flightBookingIds: [],
    save: jest.fn(async function (this: any) {
      return this;
    }),
    deleteOne: jest.fn(async () => undefined),
    toObject() {
      const { save, deleteOne, toObject, ...plain } = this;
      return plain;
    },
    ...overrides,
  });

  beforeEach(() => {
    itineraryModel = {
      create: jest.fn(async (data: any) => doc(data)),
      find: jest.fn(() => ({ sort: async () => [] })),
      findOne: jest.fn(async () => doc()),
    };
    hotelModel = {
      find: jest.fn(async () => [
        {
          _id: new Types.ObjectId(hotelId),
          status: HotelBookingStatus.CONFIRMED,
        },
      ]),
    };
    flightModel = {
      find: jest.fn(async () => [
        {
          _id: new Types.ObjectId(flightId),
          status: FlightBookingStatus.CONFIRMED,
        },
      ]),
    };
    fx = {
      convert: jest.fn(async (amount: number, from: string, to: string) => ({
        convertedAmount: amount * (from === "EUR" && to === "USD" ? 1.1 : 1),
      })),
    };
    references = {
      assertCountryCodes: jest.fn(async (codes: string[]) => codes),
      assertCityIds: jest.fn(async (ids: string[]) => ids),
    };
    currencies = {
      assertSupported: jest.fn(async (code: string) => code.trim().toUpperCase()),
    };
    service = new ItinerariesService(
      itineraryModel as never,
      hotelModel as never,
      flightModel as never,
      fx as never,
      references as never,
      currencies as never,
      { deleteActivityMedia: jest.fn(async () => undefined) } as never,
    );
  });

  it("creates a private owner itinerary with the chosen display currency", async () => {
    await service.create(ownerId, {
      title: "Trip",
      countryIds: ["EG"],
      startDate: "2099-01-01",
      displayCurrency: "eur",
    } as any);
    expect(itineraryModel.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: new Types.ObjectId(ownerId),
        visibility: ItineraryVisibility.PRIVATE,
        displayCurrency: "EUR",
        days: [],
      }),
    );
  });

  describe("reference validation (GEN-12)", () => {
    const unknown = (kind: string, id: string) =>
      new BadRequestException(`Unknown ${kind} identifier(s): ${id}`);

    it("stores dataset country codes and rejects unknown countries", async () => {
      await service.create(ownerId, {
        title: "Trip",
        countryIds: ["EG", "AE"],
        startDate: "2099-01-01",
      } as any);
      expect(references.assertCountryCodes).toHaveBeenCalledWith(["EG", "AE"], "countryIds");
      expect(itineraryModel.create).toHaveBeenCalledWith(
        expect.objectContaining({ countryIds: ["EG", "AE"] }),
      );
      references.assertCountryCodes.mockRejectedValueOnce(unknown("country", "ZZ"));
      itineraryModel.create.mockClear();
      await expect(
        service.create(ownerId, { title: "Trip", countryIds: ["ZZ"], startDate: "2099-01-01" } as any),
      ).rejects.toThrow("Unknown country identifier(s): ZZ");
      expect(itineraryModel.create).not.toHaveBeenCalled();
    });

    it("rejects an unsupported display currency", async () => {
      currencies.assertSupported.mockRejectedValueOnce(new BadRequestException("Unsupported displayCurrency"));
      await expect(
        service.create(ownerId, { title: "Trip", countryIds: ["EG"], startDate: "2099-01-01", displayCurrency: "XXX" } as any),
      ).rejects.toThrow("Unsupported displayCurrency");
      expect(itineraryModel.create).not.toHaveBeenCalled();
    });

    it("validates the city of a new day and does not save an unknown one", async () => {
      const itinerary = doc();
      itineraryModel.findOne.mockImplementationOnce((async () => itinerary) as never);
      references.assertCityIds.mockRejectedValueOnce(unknown("city", "atlantis"));
      await expect(
        service.addDay(ownerId, itineraryId, { cityId: "atlantis" } as any),
      ).rejects.toThrow("Unknown city identifier(s): atlantis");
      expect(itinerary.save).not.toHaveBeenCalled();

      const ok = doc();
      itineraryModel.findOne.mockImplementationOnce((async () => ok) as never);
      await service.addDay(ownerId, itineraryId, { cityId: "cairo" } as any);
      expect((ok as any).days[0].cityId).toBe("cairo");
    });
  });

  it("rejects an end date before the start date and ranges over 60 days", async () => {
    await expect(
      service.create(ownerId, {
        title: "Trip",
        countryIds: ["EG"],
        startDate: "2099-01-03",
        endDate: "2099-01-01",
      } as any),
    ).rejects.toThrow("endDate must be on or after startDate");
    await expect(
      service.create(ownerId, {
        title: "Trip",
        countryIds: ["EG"],
        startDate: "2099-01-01",
        endDate: "2099-03-10",
      } as any),
    ).rejects.toThrow("at most 60 days");
    expect(itineraryModel.create).not.toHaveBeenCalled();
  });

  it("does not expose itineraries that are not owned by the user", async () => {
    itineraryModel.findOne.mockResolvedValue(null as never);
    await expect(service.get(ownerId, itineraryId)).rejects.toThrow(
      "Itinerary not found",
    );
    expect(itineraryModel.findOne).toHaveBeenCalledWith({
      _id: new Types.ObjectId(itineraryId),
      ownerId: new Types.ObjectId(ownerId),
    });
  });

  it("persists the update and deletes only an owned itinerary", async () => {
    const itinerary = doc();
    itineraryModel.findOne.mockResolvedValue(itinerary as never);
    await service.update(ownerId, itineraryId, { title: "Updated" } as any);
    expect(itinerary.title).toBe("Updated");
    expect(itinerary.save).toHaveBeenCalled();
    await service.remove(ownerId, itineraryId);
    expect(itinerary.deleteOne).toHaveBeenCalled();
  });

  it("links only the user’s bookings and rejects duplicate associations", async () => {
    const itinerary = doc();
    itineraryModel.findOne.mockResolvedValue(itinerary as never);
    await service.linkBookings(ownerId, itineraryId, [hotelId], [flightId]);
    expect(itinerary.hotelBookingIds.map(String)).toContain(hotelId);
    expect(itinerary.flightBookingIds.map(String)).toContain(flightId);
    await expect(
      service.linkBookings(ownerId, itineraryId, [hotelId]),
    ).rejects.toThrow("already linked");
  });

  it("rejects bookings that do not belong to the user", async () => {
    itineraryModel.findOne.mockResolvedValue(doc() as never);
    hotelModel.find.mockResolvedValue([] as never);
    await expect(
      service.linkBookings(ownerId, itineraryId, [hotelId]),
    ).rejects.toThrow("not found for this user");
  });

  it("converts each expense from its own currency and summarizes planned and actual totals", async () => {
    const itinerary = doc({
      days: [
        {
          dayNumber: 1,
          budgets: [
            {
              description: "Meal",
              category: "food",
              amount: 10,
              currency: "EUR",
              type: BudgetEntryType.PLANNED,
            },
            {
              description: "Taxi",
              category: "in_city_transport",
              amount: 5,
              currency: "USD",
              type: BudgetEntryType.ACTUAL,
            },
          ],
        },
      ],
    });
    itineraryModel.findOne.mockResolvedValue(itinerary as never);
    const result = await service.get(ownerId, itineraryId, "usd");
    expect(result.budgetSummary).toMatchObject({
      currency: "USD",
      plannedTotal: 11,
      actualTotal: 5,
      grandTotal: { planned: 11, actual: 5 },
    });
    expect(result.budgetSummary.breakdown.food).toEqual({ planned: 11, actual: 0 });
    expect(result.budgetSummary.breakdown.in_city_transport).toEqual({ planned: 0, actual: 5 });
    expect(
      result.days[0].budgets.map((entry: any) => entry.displayAmount),
    ).toEqual([11, 5]);
    expect(fx.convert).toHaveBeenCalledWith(10, "EUR", "USD");
  });

  it("adds a dated, categorized budget entry to an owned itinerary day", async () => {
    const dayId = new Types.ObjectId().toString();
    const itinerary = doc({
      days: [
        {
          _id: new Types.ObjectId(dayId),
          dayNumber: 1,
          budgets: [],
          activities: [],
        },
      ],
    });
    itineraryModel.findOne.mockResolvedValue(itinerary as never);
    await service.addBudgetEntry(ownerId, itineraryId, dayId, {
      description: "Lunch",
      category: "food",
      amount: 20,
      currency: "EGP",
      type: BudgetEntryType.ACTUAL,
      incurredAt: "2099-01-01T12:00:00.000Z",
    } as any);
    expect((itinerary.days[0] as any).budgets).toEqual([
      expect.objectContaining({
        description: "Lunch",
        category: "food",
        amount: 20,
        currency: "EGP",
        type: BudgetEntryType.ACTUAL,
        incurredAt: new Date("2099-01-01T12:00:00.000Z"),
      }),
    ]);
    expect(itinerary.save).toHaveBeenCalled();
  });

  it("reorders days and renumbers them sequentially", async () => {
    const firstId = new Types.ObjectId().toString();
    const secondId = new Types.ObjectId().toString();
    const itinerary = doc({
      days: [
        { _id: new Types.ObjectId(firstId), dayNumber: 1 },
        { _id: new Types.ObjectId(secondId), dayNumber: 2 },
      ],
    });
    itineraryModel.findOne.mockResolvedValue(itinerary as never);
    await service.reorderDays(ownerId, itineraryId, {
      dayIds: [secondId, firstId],
    });
    expect(
      (itinerary.days as any[]).map((day) => [String(day._id), day.dayNumber]),
    ).toEqual([
      [secondId, 1],
      [firstId, 2],
    ]);
    await expect(
      service.reorderDays(ownerId, itineraryId, { dayIds: [secondId] }),
    ).rejects.toThrow("every itinerary day");
  });

  it("rejects links to cancelled or expired bookings", async () => {
    itineraryModel.findOne.mockResolvedValue(doc() as never);
    hotelModel.find.mockResolvedValue([
      {
        _id: new Types.ObjectId(hotelId),
        status: HotelBookingStatus.CANCELLED,
      },
    ] as never);
    await expect(
      service.linkBookings(ownerId, itineraryId, [hotelId]),
    ).rejects.toThrow("Cancelled or expired hotel bookings");
    flightModel.find.mockResolvedValue([
      {
        _id: new Types.ObjectId(flightId),
        status: FlightBookingStatus.EXPIRED,
      },
    ] as never);
    await expect(
      service.linkBookings(ownerId, itineraryId, [], [flightId]),
    ).rejects.toThrow("Cancelled or expired flight bookings");
  });
});
