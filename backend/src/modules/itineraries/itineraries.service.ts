import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isValidObjectId, Model, Types } from "mongoose";
import { ReferenceValidationService } from "../reference-data/reference-validation.service";
import { SupportedCurrenciesService } from "../reference-data/supported-currencies.service";
import { FxRatesService } from "../../integrations/fx-rates/fx-rates.service";
import { FlightBooking } from "../flight-bookings/schemas/flight-booking.schema";
import { FlightBookingStatus } from "../flight-bookings/enums/flight-booking-status.enum";
import {
  HotelBooking,
  HotelBookingStatus,
} from "../hotel-bookings/schemas/hotel-booking.schema";
import {
  CreateItineraryActivityDto,
  CreateItineraryDayDto,
  CreateItineraryDto,
  CreateBudgetEntryDto,
  CreateTransportCostDto,
  UpdateItineraryActivityDto,
  UpdateItineraryDayDto,
  UpdateItineraryDto,
  UpdateBudgetEntryDto,
  UpdateTransportCostDto,
  ReorderItineraryDaysDto,
} from "./dto/itineraries.dto";
import { Itinerary } from "./schemas/itinerary.schema";
import { BudgetEntryType } from "./schemas/budget.schema";
import { ItineraryVisibility } from "./enums/itinerary-visibility.enum";
import { cityGroups, dayDate } from "./itinerary-days";

@Injectable()
export class ItinerariesService {
  constructor(
    @InjectModel(Itinerary.name) private readonly itineraries: Model<Itinerary>,
    @InjectModel(HotelBooking.name)
    private readonly hotelBookings: Model<HotelBooking>,
    @InjectModel(FlightBooking.name)
    private readonly flightBookings: Model<FlightBooking>,
    private readonly fxRates: FxRatesService,
    private readonly references: ReferenceValidationService,
    private readonly currencies: SupportedCurrenciesService,
  ) {}

  async create(ownerId: string, dto: CreateItineraryDto) {
    const startDate = this.parseDate(dto.startDate, "startDate");
    const endDate = dto.endDate ? this.parseDate(dto.endDate, "endDate") : null;
    this.validateDateRange(startDate, endDate);
    const countryIds = await this.references.assertCountryCodes(
      dto.countryIds,
      "countryIds",
    );
    const displayCurrency = dto.displayCurrency
      ? await this.currencies.assertSupported(
          dto.displayCurrency,
          "displayCurrency",
        )
      : "USD";
    const itinerary: any = await this.itineraries.create({
      ownerId: new Types.ObjectId(ownerId),
      title: dto.title,
      countryIds,
      startDate,
      endDate,
      days: [],
      visibility: dto.visibility ?? ItineraryVisibility.PRIVATE,
      displayCurrency,
    } as any);
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async list(ownerId: string, displayCurrency?: string) {
    const currency = await this.normalizeDisplayCurrency(displayCurrency);
    const rows = await this.itineraries
      .find({ ownerId })
      .sort({ startDate: 1, _id: 1 });
    return Promise.all(
      rows.map((row) => this.present(row, currency ?? row.displayCurrency)),
    );
  }

  async get(ownerId: string, id: string, displayCurrency?: string) {
    const itinerary = await this.findOwned(ownerId, id);
    return this.present(
      itinerary,
      (await this.normalizeDisplayCurrency(displayCurrency)) ??
        itinerary.displayCurrency,
    );
  }

  async update(ownerId: string, id: string, dto: UpdateItineraryDto) {
    const itinerary = await this.findOwned(ownerId, id);
    const startDate = dto.startDate
      ? this.parseDate(dto.startDate, "startDate")
      : itinerary.startDate;
    const endDate =
      dto.endDate !== undefined
        ? this.parseDate(dto.endDate, "endDate")
        : itinerary.endDate;
    this.validateDateRange(startDate, endDate ?? null);

    if (dto.title !== undefined) itinerary.title = dto.title;
    if (dto.countryIds !== undefined)
      itinerary.countryIds = (await this.references.assertCountryCodes(
        dto.countryIds,
        "countryIds",
      )) as any;
    if (dto.startDate !== undefined) itinerary.startDate = startDate;
    if (dto.endDate !== undefined) itinerary.endDate = endDate;
    if (dto.visibility !== undefined) itinerary.visibility = dto.visibility;
    if (dto.displayCurrency !== undefined)
      itinerary.displayCurrency = await this.currencies.assertSupported(
        dto.displayCurrency,
        "displayCurrency",
      );

    if (
      endDate &&
      itinerary.days.length > this.inclusiveDays(startDate, endDate)
    ) {
      throw new BadRequestException(
        "The itinerary date range cannot be shorter than its existing day plan",
      );
    }

    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async remove(ownerId: string, id: string) {
    const itinerary = await this.findOwned(ownerId, id);
    await itinerary.deleteOne();
    return { id, deleted: true };
  }

  async linkBookings(
    ownerId: string,
    id: string,
    hotelIds: string[] = [],
    flightIds: string[] = [],
  ) {
    if (!hotelIds.length && !flightIds.length)
      throw new BadRequestException("At least one booking ID is required");
    const itinerary = await this.findOwned(ownerId, id);
    const hotelObjectIds = hotelIds.map((bookingId) =>
      this.objectId(bookingId),
    );
    const flightObjectIds = flightIds.map((bookingId) =>
      this.objectId(bookingId),
    );
    const [hotels, flights] = await Promise.all([
      hotelObjectIds.length
        ? this.hotelBookings.find({
            _id: { $in: hotelObjectIds },
            userId: ownerId,
          })
        : [],
      flightObjectIds.length
        ? this.flightBookings.find({
            _id: { $in: flightObjectIds },
            userId: ownerId,
          })
        : [],
    ]);
    if (
      hotels.length !== hotelIds.length ||
      flights.length !== flightIds.length
    ) {
      throw new NotFoundException(
        "One or more bookings were not found for this user",
      );
    }
    if (
      hotels.some((booking) =>
        [HotelBookingStatus.CANCELLED, HotelBookingStatus.EXPIRED].includes(
          booking.status,
        ),
      )
    ) {
      throw new BadRequestException(
        "Cancelled or expired hotel bookings cannot be linked",
      );
    }
    if (
      flights.some((booking) =>
        [FlightBookingStatus.CANCELLED, FlightBookingStatus.EXPIRED].includes(
          booking.status,
        ),
      )
    ) {
      throw new BadRequestException(
        "Cancelled or expired flight bookings cannot be linked",
      );
    }
    const currentHotels = new Set(itinerary.hotelBookingIds.map(String));
    const currentFlights = new Set(itinerary.flightBookingIds.map(String));
    if (
      hotelIds.some((bookingId) => currentHotels.has(bookingId)) ||
      flightIds.some((bookingId) => currentFlights.has(bookingId))
    ) {
      throw new BadRequestException(
        "A booking is already linked to this itinerary",
      );
    }
    itinerary.hotelBookingIds.push(...hotelObjectIds);
    itinerary.flightBookingIds.push(...flightObjectIds);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async unlinkBooking(ownerId: string, id: string, bookingId: string) {
    const itinerary = await this.findOwned(ownerId, id);
    const hotelIndex = itinerary.hotelBookingIds.findIndex(
      (value) => String(value) === bookingId,
    );
    const flightIndex = itinerary.flightBookingIds.findIndex(
      (value) => String(value) === bookingId,
    );
    if (hotelIndex < 0 && flightIndex < 0)
      throw new NotFoundException("Booking is not linked to this itinerary");
    if (hotelIndex >= 0) itinerary.hotelBookingIds.splice(hotelIndex, 1);
    if (flightIndex >= 0) itinerary.flightBookingIds.splice(flightIndex, 1);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async addDay(ownerId: string, id: string, dto: CreateItineraryDayDto) {
    const itinerary = await this.findOwned(ownerId, id);
    if (itinerary.days.length >= 60)
      throw new BadRequestException("An itinerary can contain at most 60 days");
    if (
      itinerary.endDate &&
      itinerary.days.length >=
        this.inclusiveDays(itinerary.startDate, itinerary.endDate)
    ) {
      throw new BadRequestException(
        "The itinerary date range already contains all available days",
      );
    }
    const [cityId] = await this.references.assertCityIds([dto.cityId]);
    itinerary.days.push({
      dayNumber: itinerary.days.length + 1,
      cityId,
      notes: dto.notes ?? "",
      activities: [],
      budgets: [],
    } as any);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async updateDay(
    ownerId: string,
    id: string,
    dayId: string,
    dto: UpdateItineraryDayDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    if (dto.cityId !== undefined) {
      const [cityId] = await this.references.assertCityIds([dto.cityId]);
      day.cityId = cityId;
    }
    if (dto.notes !== undefined) day.notes = dto.notes;
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async removeDay(ownerId: string, id: string, dayId: string) {
    const { itinerary, index } = await this.findDay(ownerId, id, dayId);
    itinerary.days.splice(index, 1);
    itinerary.days.forEach((day, i) => (day.dayNumber = i + 1));
    itinerary.transportCosts = itinerary.transportCosts.filter(
      (cost) => String(cost.dayId) !== dayId,
    ) as any;
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async reorderDays(ownerId: string, id: string, dto: ReorderItineraryDaysDto) {
    const itinerary = await this.findOwned(ownerId, id);
    const existing = itinerary.days.map((day: any) => String(day._id));
    if (
      dto.dayIds.length !== existing.length ||
      dto.dayIds.some((dayId) => !existing.includes(dayId))
    ) {
      throw new BadRequestException(
        "dayIds must contain every itinerary day exactly once",
      );
    }
    const byId = new Map(
      (itinerary.days as any[]).map((day) => [String(day._id), day]),
    );
    itinerary.days = dto.dayIds.map((dayId, index) => {
      const day: any = byId.get(dayId);
      day.dayNumber = index + 1;
      return day;
    }) as any;
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async addActivity(
    ownerId: string,
    id: string,
    dayId: string,
    dto: CreateItineraryActivityDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    day.activities.push(dto as any);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async updateActivity(
    ownerId: string,
    id: string,
    dayId: string,
    activityId: string,
    dto: UpdateItineraryActivityDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    const activity: any = (day.activities as any[]).find(
      (item) => String(item._id) === activityId,
    );
    if (!activity) throw new NotFoundException("Activity not found");
    Object.assign(activity, dto);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async removeActivity(
    ownerId: string,
    id: string,
    dayId: string,
    activityId: string,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    const index = (day.activities as any[]).findIndex(
      (item) => String(item._id) === activityId,
    );
    if (index < 0) throw new NotFoundException("Activity not found");
    day.activities.splice(index, 1);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async addBudgetEntry(
    ownerId: string,
    id: string,
    dayId: string,
    dto: CreateBudgetEntryDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    dto.currency = await this.currencies.assertSupported(dto.currency);
    day.budgets.push({
      ...dto,
      type: dto.type ?? BudgetEntryType.PLANNED,
      incurredAt: dto.incurredAt
        ? this.parseDate(dto.incurredAt, "incurredAt")
        : new Date(),
    } as any);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async updateBudgetEntry(
    ownerId: string,
    id: string,
    dayId: string,
    entryId: string,
    dto: UpdateBudgetEntryDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    const entry: any = (day.budgets as any[]).find(
      (item) => String(item._id) === entryId,
    );
    if (!entry) throw new NotFoundException("Budget entry not found");
    if (dto.currency !== undefined)
      dto.currency = await this.currencies.assertSupported(dto.currency);
    Object.assign(
      entry,
      dto,
      dto.incurredAt
        ? { incurredAt: this.parseDate(dto.incurredAt, "incurredAt") }
        : {},
    );
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async removeBudgetEntry(
    ownerId: string,
    id: string,
    dayId: string,
    entryId: string,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dayId);
    const index = (day.budgets as any[]).findIndex(
      (item) => String(item._id) === entryId,
    );
    if (index < 0) throw new NotFoundException("Budget entry not found");
    day.budgets.splice(index, 1);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async addTransportCost(
    ownerId: string,
    id: string,
    dto: CreateTransportCostDto,
  ) {
    const { itinerary, day } = await this.findDay(ownerId, id, dto.dayId);
    if (!day) throw new NotFoundException("Day not found");
    await this.references.assertCityIds(
      [dto.fromCityId, dto.toCityId],
      "fromCityId/toCityId",
    );
    dto.currency = await this.currencies.assertSupported(dto.currency);
    itinerary.transportCosts.push({
      ...dto,
      fromCityId: dto.fromCityId.trim(),
      toCityId: dto.toCityId.trim(),
      dayId: new Types.ObjectId(dto.dayId),
    } as any);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async updateTransportCost(
    ownerId: string,
    id: string,
    costId: string,
    dto: UpdateTransportCostDto,
  ) {
    const itinerary = await this.findOwned(ownerId, id);
    const cost: any = (itinerary.transportCosts as any[]).find(
      (item) => String(item._id) === costId,
    );
    if (!cost) throw new NotFoundException("Transport cost not found");
    if (dto.dayId) this.findDayInDocument(itinerary, dto.dayId);
    if (dto.fromCityId)
      await this.references.assertCityIds([dto.fromCityId], "fromCityId");
    if (dto.toCityId)
      await this.references.assertCityIds([dto.toCityId], "toCityId");
    if (dto.currency !== undefined)
      dto.currency = await this.currencies.assertSupported(dto.currency);
    Object.assign(
      cost,
      dto,
      dto.dayId ? { dayId: new Types.ObjectId(dto.dayId) } : {},
      dto.fromCityId ? { fromCityId: dto.fromCityId.trim() } : {},
      dto.toCityId ? { toCityId: dto.toCityId.trim() } : {},
    );
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  async removeTransportCost(ownerId: string, id: string, costId: string) {
    const itinerary = await this.findOwned(ownerId, id);
    const index = (itinerary.transportCosts as any[]).findIndex(
      (item) => String(item._id) === costId,
    );
    if (index < 0) throw new NotFoundException("Transport cost not found");
    itinerary.transportCosts.splice(index, 1);
    await itinerary.save();
    return this.present(itinerary, itinerary.displayCurrency);
  }

  /** GET /itineraries/:id/budget-summary: the budgetSummary section of the same view as get(). */
  async budgetSummary(ownerId: string, id: string, displayCurrency?: string) {
    const view = await this.get(ownerId, id, displayCurrency);
    return { itineraryId: id, ...view.budgetSummary };
  }

  // The routes /activities/:id, /budgets/:id and /transport-costs/:id carry no itinerary id.
  // These resolve the owning itinerary (restricted to the caller's own itineraries, so another
  // user's id is a 404 exactly like the nested routes) and delegate to the existing methods.
  async updateActivityById(ownerId: string, activityId: string, dto: UpdateItineraryActivityDto) {
    const { itineraryId, dayId } = await this.locateDayItem(ownerId, "activities", activityId);
    return this.updateActivity(ownerId, itineraryId, dayId, activityId, dto);
  }

  async removeActivityById(ownerId: string, activityId: string) {
    const { itineraryId, dayId } = await this.locateDayItem(ownerId, "activities", activityId);
    return this.removeActivity(ownerId, itineraryId, dayId, activityId);
  }

  async updateBudgetEntryById(ownerId: string, entryId: string, dto: UpdateBudgetEntryDto) {
    const { itineraryId, dayId } = await this.locateDayItem(ownerId, "budgets", entryId);
    return this.updateBudgetEntry(ownerId, itineraryId, dayId, entryId, dto);
  }

  async removeBudgetEntryById(ownerId: string, entryId: string) {
    const { itineraryId, dayId } = await this.locateDayItem(ownerId, "budgets", entryId);
    return this.removeBudgetEntry(ownerId, itineraryId, dayId, entryId);
  }

  async updateTransportCostById(ownerId: string, costId: string, dto: UpdateTransportCostDto) {
    const itineraryId = await this.locateTransportCost(ownerId, costId);
    return this.updateTransportCost(ownerId, itineraryId, costId, dto);
  }

  async removeTransportCostById(ownerId: string, costId: string) {
    const itineraryId = await this.locateTransportCost(ownerId, costId);
    return this.removeTransportCost(ownerId, itineraryId, costId);
  }

  private async locateDayItem(ownerId: string, kind: "activities" | "budgets", itemId: string) {
    const itinerary: any = await this.itineraries
      .findOne({
        ownerId: this.objectId(ownerId),
        [`days.${kind}._id`]: this.objectId(itemId),
      })
      .select({ days: 1 });
    const day = (itinerary?.days ?? []).find((candidate: any) =>
      (candidate[kind] ?? []).some((item: any) => String(item._id) === itemId),
    );
    if (!itinerary || !day)
      throw new NotFoundException(kind === "activities" ? "Activity not found" : "Budget entry not found");
    return { itineraryId: String(itinerary._id), dayId: String(day._id) };
  }

  private async locateTransportCost(ownerId: string, costId: string) {
    const itinerary: any = await this.itineraries
      .findOne({
        ownerId: this.objectId(ownerId),
        "transportCosts._id": this.objectId(costId),
      })
      .select({ _id: 1 });
    if (!itinerary) throw new NotFoundException("Transport cost not found");
    return String(itinerary._id);
  }

  private async present(itinerary: any, currency: string) {
    const entries = (itinerary.days ?? []).flatMap(
      (day: any) => day.budgets ?? [],
    );
    const transportCosts = itinerary.transportCosts ?? [];
    const convertAmount = async (amount: number, from: string) => {
      if (from === currency || amount === 0) return amount;
      return (await this.fxRates.convert(amount, from, currency))
        .convertedAmount;
    };
    const toTotal = async (type: BudgetEntryType) => {
      const selected = entries.filter((entry: any) => entry.type === type);
      const converted = await Promise.all(
        selected.map((entry: any) =>
          convertAmount(Number(entry.amount), entry.currency),
        ),
      );
      if (type === BudgetEntryType.PLANNED) {
        converted.push(
          ...(await Promise.all(
            transportCosts.map((cost: any) =>
              convertAmount(Number(cost.amount), cost.currency),
            ),
          )),
        );
      }
      return Number(
        converted.reduce((sum, amount) => sum + amount, 0).toFixed(2),
      );
    };
    const result = itinerary.toObject();
    const [hotelBookings, flightBookings] = await Promise.all([
      itinerary.hotelBookingIds?.length
        ? this.hotelBookings.find({
            _id: { $in: itinerary.hotelBookingIds },
            userId: itinerary.ownerId,
          })
        : [],
      itinerary.flightBookingIds?.length
        ? this.flightBookings.find({
            _id: { $in: itinerary.flightBookingIds },
            userId: itinerary.ownerId,
          })
        : [],
    ]);
    const days = await Promise.all(
      (result.days ?? []).map(async (day: any) => ({
        ...day,
        // ITN-05: derived, never stored (startDate + dayNumber - 1).
        date: dayDate(itinerary.startDate, day.dayNumber),
        budgets: await Promise.all(
          (day.budgets ?? []).map(async (entry: any) => ({
            ...entry,
            displayAmount: await convertAmount(
              Number(entry.amount),
              entry.currency,
            ),
            displayCurrency: currency,
          })),
        ),
      })),
    );
    return {
      ...result,
      days,
      // ITN-09: runs of consecutive days in the same city, computed on read.
      cityGroups: cityGroups(result.days ?? [], itinerary.startDate),
      linkedBookings: {
        hotels: hotelBookings.map((booking: any) => ({
          id: String(booking._id),
          status: booking.status,
          reference: booking.reference,
          checkInDate: booking.checkInDate,
          checkOutDate: booking.checkOutDate,
          totalPrice: booking.totalPrice,
          currency: booking.currency,
        })),
        flights: flightBookings.map((booking: any) => ({
          id: String(booking._id),
          status: booking.status,
          reference: booking.reference,
          departureTime: booking.departureTime,
          totalPrice: booking.totalPrice,
          currency: booking.currency,
        })),
      },
      transportCosts: await Promise.all(
        transportCosts.map(async (cost: any) => ({
          ...cost,
          displayAmount: await convertAmount(
            Number(cost.amount),
            cost.currency,
          ),
          displayCurrency: currency,
        })),
      ),
      budgetSummary: {
        currency,
        plannedTotal: await toTotal(BudgetEntryType.PLANNED),
        actualTotal: await toTotal(BudgetEntryType.ACTUAL),
      },
    };
  }

  private async findOwned(ownerId: string, id: string) {
    const objectId = this.objectId(id);
    const itinerary = await this.itineraries.findOne({
      _id: objectId,
      ownerId: this.objectId(ownerId),
    });
    if (!itinerary) throw new NotFoundException("Itinerary not found");
    return itinerary;
  }

  private async findDay(ownerId: string, id: string, dayId: string) {
    const itinerary = await this.findOwned(ownerId, id);
    const index = (itinerary.days as any[]).findIndex(
      (day) => String(day._id) === dayId,
    );
    if (index < 0) throw new NotFoundException("Itinerary day not found");
    return { itinerary, day: itinerary.days[index], index };
  }

  private findDayInDocument(itinerary: any, dayId: string) {
    if (!(itinerary.days as any[]).some((day) => String(day._id) === dayId))
      throw new NotFoundException("Itinerary day not found");
  }

  private objectId(value: string) {
    if (!isValidObjectId(value))
      throw new BadRequestException("Invalid MongoDB ID");
    return new Types.ObjectId(value);
  }

  private parseDate(value: string, field: string) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime()))
      throw new BadRequestException(`${field} must be a valid date`);
    return date;
  }

  private validateDateRange(start: Date, end: Date | null) {
    if (end && end < start)
      throw new BadRequestException("endDate must be on or after startDate");
    if (end && this.inclusiveDays(start, end) > 60)
      throw new BadRequestException("An itinerary can contain at most 60 days");
  }

  private inclusiveDays(start: Date, end: Date) {
    const utcStart = Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth(),
      start.getUTCDate(),
    );
    const utcEnd = Date.UTC(
      end.getUTCFullYear(),
      end.getUTCMonth(),
      end.getUTCDate(),
    );
    return Math.floor((utcEnd - utcStart) / 86400000) + 1;
  }

  private async normalizeDisplayCurrency(value?: string) {
    if (!value) return undefined;
    const normalized = value.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(normalized))
      throw new BadRequestException(
        "displayCurrency must be a three-letter currency code",
      );
    return this.currencies.assertSupported(normalized, "displayCurrency");
  }
}
