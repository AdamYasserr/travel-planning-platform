import { jest } from "@jest/globals";
import { NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { ItinerariesService } from "./itineraries.service";

/** Each top-level alias must give exactly the nested route's result, and only for the owner's items. */
describe("ItinerariesService id-only aliases", () => {
  const owner = new Types.ObjectId();
  const stranger = new Types.ObjectId();
  const itineraryId = new Types.ObjectId();
  const dayId = new Types.ObjectId();
  const activityId = new Types.ObjectId();
  const budgetId = new Types.ObjectId();
  const costId = new Types.ObjectId();
  const museumId = new Types.ObjectId();

  const plain = () => ({
    _id: itineraryId,
    ownerId: owner,
    title: "Trip",
    countryIds: ["EG"],
    startDate: new Date("2099-01-01T00:00:00Z"),
    endDate: null,
    visibility: "private",
    displayCurrency: "USD",
    hotelBookingIds: [],
    flightBookingIds: [],
    days: [
      {
        _id: dayId,
        dayNumber: 1,
        cityId: "cairo",
        notes: "",
        activities: [{ _id: activityId, title: "Pyramids" }, { _id: museumId, title: "Museum" }],
        budgets: [{ _id: budgetId, category: "food", amount: 20, currency: "USD", type: "planned" }],
      },
    ],
    transportCosts: [{ _id: costId, mode: "bus", amount: 5, currency: "USD", fromCityId: "cairo", toCityId: "dubai", dayId }],
  });

  /** A fresh store + service each time so nested and alias calls start from identical state. */
  function build() {
    const doc: any = plain();
    doc.save = jest.fn(async () => doc);
    doc.toObject = () => JSON.parse(JSON.stringify({ ...doc, save: undefined, toObject: undefined }));
    const inDays = (kind: string, id: unknown) => doc.days.some((d: any) => d[kind].some((i: any) => String(i._id) === String(id)));
    const matches = (filter: any) => {
      if (filter.ownerId && String(filter.ownerId) !== String(doc.ownerId)) return false;
      if (filter._id && String(filter._id) !== String(doc._id)) return false;
      if (filter["days.activities._id"]) return inDays("activities", filter["days.activities._id"]);
      if (filter["days.budgets._id"]) return inDays("budgets", filter["days.budgets._id"]);
      if (filter["transportCosts._id"]) return doc.transportCosts.some((c: any) => String(c._id) === String(filter["transportCosts._id"]));
      return true;
    };
    const itineraries = {
      findOne: jest.fn((filter: any) => {
        const result = matches(filter) ? doc : null;
        const p: any = Promise.resolve(result);
        p.select = () => Promise.resolve(result);
        return p;
      }),
    };
    const fx = { convert: jest.fn(async (amount: number) => ({ convertedAmount: amount })) };
    const references = { assertCityIds: jest.fn(async (ids: string[]) => ids), assertCountryCodes: jest.fn(async (c: string[]) => c) };
    const currencies = { assertSupported: jest.fn(async (c: string) => c.toUpperCase()) };
    const empty = { find: jest.fn(async () => []) };
    const service = new ItinerariesService(itineraries as never, empty as never, empty as never, fx as never, references as never, currencies as never);
    return { service, doc };
  }
  const own = owner.toString();

  it("PATCH /activities/:id equals the nested update", async () => {
    const a = build();
    const b = build();
    const nested = await a.service.updateActivity(own, itineraryId.toString(), dayId.toString(), activityId.toString(), { title: "Giza" } as never);
    const alias = await b.service.updateActivityById(own, activityId.toString(), { title: "Giza" } as never);
    expect(alias).toEqual(nested);
    expect(b.doc.days[0].activities[0].title).toBe("Giza");
    expect(b.doc.save).toHaveBeenCalledTimes(1);
  });

  it("DELETE /activities/:id equals the nested delete", async () => {
    const a = build();
    const b = build();
    const nested = await a.service.removeActivity(own, itineraryId.toString(), dayId.toString(), activityId.toString());
    const alias = await b.service.removeActivityById(own, activityId.toString());
    expect(alias).toEqual(nested);
    expect(b.doc.days[0].activities).toHaveLength(1);
  });

  it("PATCH and DELETE /budgets/:id equal the nested budget-entry routes", async () => {
    const a = build();
    const b = build();
    const dto = { amount: 42, currency: "usd" } as never;
    expect(await b.service.updateBudgetEntryById(own, budgetId.toString(), dto)).toEqual(
      await a.service.updateBudgetEntry(own, itineraryId.toString(), dayId.toString(), budgetId.toString(), dto),
    );
    expect(b.doc.days[0].budgets[0]).toMatchObject({ amount: 42, currency: "USD" });
    const c = build();
    const d = build();
    expect(await d.service.removeBudgetEntryById(own, budgetId.toString())).toEqual(
      await c.service.removeBudgetEntry(own, itineraryId.toString(), dayId.toString(), budgetId.toString()),
    );
    expect(d.doc.days[0].budgets).toHaveLength(0);
  });

  it("PATCH and DELETE /transport-costs/:id equal the nested routes", async () => {
    const a = build();
    const b = build();
    const dto = { amount: 9, currency: "usd" } as never;
    expect(await b.service.updateTransportCostById(own, costId.toString(), dto)).toEqual(
      await a.service.updateTransportCost(own, itineraryId.toString(), costId.toString(), dto),
    );
    expect(b.doc.transportCosts[0]).toMatchObject({ amount: 9, currency: "USD" });
    const c = build();
    const d = build();
    expect(await d.service.removeTransportCostById(own, costId.toString())).toEqual(
      await c.service.removeTransportCost(own, itineraryId.toString(), costId.toString()),
    );
    expect(d.doc.transportCosts).toHaveLength(0);
  });

  it("another user's item ids are 404 on the alias, exactly like the nested route, and nothing is saved", async () => {
    const { service, doc } = build();
    const ids = { activity: activityId.toString(), budget: budgetId.toString(), cost: costId.toString() };
    const stranger_ = stranger.toString();
    await expect(service.updateActivityById(stranger_, ids.activity, { title: "x" } as never)).rejects.toThrow(new NotFoundException("Activity not found"));
    await expect(service.removeActivityById(stranger_, ids.activity)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateBudgetEntryById(stranger_, ids.budget, { amount: 1 } as never)).rejects.toThrow("Budget entry not found");
    await expect(service.removeBudgetEntryById(stranger_, ids.budget)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateTransportCostById(stranger_, ids.cost, { amount: 1 } as never)).rejects.toThrow("Transport cost not found");
    await expect(service.removeTransportCostById(stranger_, ids.cost)).rejects.toBeInstanceOf(NotFoundException);
    // the nested route says 404 as well
    await expect(service.updateActivity(stranger_, itineraryId.toString(), dayId.toString(), ids.activity, { title: "x" } as never)).rejects.toThrow("Itinerary not found");
    expect(doc.save).not.toHaveBeenCalled();
  });

  it("unknown or malformed ids are 404 / 400, never a crash", async () => {
    const { service } = build();
    await expect(service.removeActivityById(own, new Types.ObjectId().toString())).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.removeActivityById(own, "not-an-id")).rejects.toThrow("Invalid MongoDB ID");
  });

  it("budget-summary returns the budgetSummary section of GET /itineraries/:id", async () => {
    const a = build();
    const b = build();
    const full: any = await a.service.get(own, itineraryId.toString());
    const summary = await b.service.budgetSummary(own, itineraryId.toString());
    expect(summary).toEqual({ itineraryId: itineraryId.toString(), ...full.budgetSummary });
    expect(summary).toMatchObject({ currency: "USD", plannedTotal: 25, actualTotal: 0 });
    await expect(b.service.budgetSummary(stranger.toString(), itineraryId.toString())).rejects.toBeInstanceOf(NotFoundException);
  });
});
