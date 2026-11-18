import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';

import { presentAuthor } from '../../common/users/deleted-user';
import { paged } from '../../common/pagination/pagination';
import { fieldErrors } from '../../common/pipes/validation.pipe';
import { User } from '../../users/user.schema';
import { CloneItineraryDto, PublicItinerarySearchQueryDto } from './dto/public-itineraries.dto';
import { ItinerariesService } from './itineraries.service';
import { BudgetEntryType } from './schemas/budget.schema';
import { ItineraryVisibility } from './enums/itinerary-visibility.enum';
import { cityGroups, dayDate } from './itinerary-days';
import { Itinerary } from './schemas/itinerary.schema';

const DAY_MS = 86_400_000;
const utcDay = (value: string) => new Date(`${value}T00:00:00.000Z`);

/**
 * The MongoDB filter of the public search. Only public itineraries are ever matched. An itinerary runs from
 * its start date to its end date; without an end date it runs for as many days as it has (at least one).
 */
export function publicSearchFilter(q: Pick<PublicItinerarySearchQueryDto, 'city' | 'country' | 'from' | 'to'>) {
  const filter: Record<string, unknown> = { visibility: ItineraryVisibility.PUBLIC };
  if (q.city) filter['days.cityId'] = q.city;
  if (q.country) filter.countryIds = q.country;
  if (q.to) filter.startDate = { $lt: new Date(utcDay(q.to).getTime() + DAY_MS) };
  if (q.from) {
    const lastDay = {
      $ifNull: [
        '$endDate',
        { $dateAdd: { startDate: '$startDate', unit: 'day', amount: { $max: [{ $subtract: [{ $size: { $ifNull: ['$days', []] } }, 1] }, 0] } } },
      ],
    };
    filter.$expr = { $gte: [lastDay, utcDay(q.from)] };
  }
  return filter;
}

/**
 * ITN-20 / ITN-21: public discovery. These methods never return a private itinerary, and never return
 * budgets, transport costs, linked bookings, payments, the owner's id or e-mail, or activity costs.
 */
@Injectable()
export class PublicItinerariesService {
  constructor(
    @InjectModel(Itinerary.name) private readonly itineraries: Model<Itinerary>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly itinerariesService: ItinerariesService,
  ) {}

  /**
   * ITN-21: copies an itinerary into the caller's account as a new PRIVATE itinerary with attribution
   * (clonedFrom). The source must be public, or the caller's own; anything else is 404.
   * Copied: title, countries, days, notes, activity name / description / time, planned budget entries and
   * transport costs. Never copied: images, activity costs, actual spending, booking links, payments.
   * Dates are derived, so a different startDate just moves the whole clone (an end date keeps its length).
   */
  async clone(userId: string, id: string, dto: CloneItineraryDto) {
    if (!isValidObjectId(id) || !isValidObjectId(userId)) throw new BadRequestException('Invalid MongoDB ID');
    const source: any = await this.itineraries.findOne({ _id: new Types.ObjectId(id) }).lean().exec();
    const isOwner = !!source && String(source.ownerId) === userId;
    if (!source || (source.visibility !== ItineraryVisibility.PUBLIC && !isOwner)) {
      throw new NotFoundException('Itinerary not found');
    }
    const authorName = (await this.authorNames([source.ownerId])).get(String(source.ownerId)) ?? presentAuthor(null).name;

    const startDate = dto.startDate ? new Date(dto.startDate) : source.startDate;
    const endDate = source.endDate ? new Date(startDate.getTime() + (source.endDate.getTime() - source.startDate.getTime())) : null;

    const newDayIds = new Map<string, Types.ObjectId>();
    const days = (source.days ?? []).map((day: any) => {
      const _id = new Types.ObjectId();
      newDayIds.set(String(day._id), _id);
      return {
        _id,
        dayNumber: day.dayNumber,
        cityId: day.cityId,
        notes: day.notes ?? '',
        activities: (day.activities ?? []).map((activity: any) => ({
          name: activity.name,
          description: activity.description,
          ...(activity.time ? { time: activity.time } : {}),
        })),
        budgets: (day.budgets ?? [])
          .filter((entry: any) => entry.type !== BudgetEntryType.ACTUAL)
          .map((entry: any) => ({
            description: entry.description,
            category: entry.category,
            amount: entry.amount,
            currency: entry.currency,
            type: BudgetEntryType.PLANNED,
            incurredAt: new Date(),
          })),
      };
    });
    const transportCosts = (source.transportCosts ?? [])
      .filter((cost: any) => newDayIds.has(String(cost.dayId)))
      .map((cost: any) => ({
        mode: cost.mode,
        fromCityId: cost.fromCityId,
        toCityId: cost.toCityId,
        amount: cost.amount,
        currency: cost.currency,
        dayId: newDayIds.get(String(cost.dayId)),
      }));

    const created = await this.itineraries.create({
      ownerId: new Types.ObjectId(userId),
      title: source.title,
      countryIds: source.countryIds,
      startDate,
      endDate,
      days,
      transportCosts,
      visibility: ItineraryVisibility.PRIVATE,
      displayCurrency: source.displayCurrency,
      hotelBookingIds: [],
      flightBookingIds: [],
      clonedFrom: { itineraryId: source._id, authorName },
    } as never);
    return this.itinerariesService.get(userId, String(created._id));
  }

  async search(query: PublicItinerarySearchQueryDto) {
    if (query.from && query.to && query.from > query.to) {
      throw fieldErrors([{ field: 'to', messages: ['to must not be before from'] }]);
    }
    const filter = publicSearchFilter(query);
    const [rows, total] = await Promise.all([
      this.itineraries
        .find(filter as never)
        .select({ title: 1, countryIds: 1, startDate: 1, endDate: 1, ownerId: 1, createdAt: 1, clonedFrom: 1, 'days._id': 1, 'days.dayNumber': 1, 'days.cityId': 1 })
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<any[]>()
        .exec(),
      this.itineraries.countDocuments(filter as never).exec(),
    ]);
    const authors = await this.authorNames(rows.map((row) => row.ownerId));
    const items = rows.map((row) => ({
      id: String(row._id),
      title: row.title,
      countryIds: row.countryIds,
      startDate: row.startDate,
      endDate: row.endDate ?? null,
      dayCount: (row.days ?? []).length,
      cities: [...new Set<string>((row.days ?? []).map((day: any) => day.cityId))],
      author: { name: authors.get(String(row.ownerId)) ?? presentAuthor(null).name },
      ...(row.clonedFrom ? { clonedFrom: row.clonedFrom } : {}),
      createdAt: row.createdAt,
    }));
    return paged(items, total, query.page, query.limit);
  }

  /** A private, hidden or unknown itinerary is 404: nothing tells the caller that it exists. */
  async detail(id: string) {
    if (!isValidObjectId(id)) throw new BadRequestException('Invalid MongoDB ID');
    const row: any = await this.itineraries
      .findOne({ _id: new Types.ObjectId(id), visibility: ItineraryVisibility.PUBLIC })
      .lean()
      .exec();
    if (!row) throw new NotFoundException('Itinerary not found');
    const authors = await this.authorNames([row.ownerId]);
    const days = (row.days ?? []).map((day: any) => ({
      id: String(day._id),
      dayNumber: day.dayNumber,
      date: dayDate(row.startDate, day.dayNumber),
      cityId: day.cityId,
      notes: day.notes ?? '',
      activities: (day.activities ?? []).map((activity: any) => ({
        id: String(activity._id),
        name: activity.name,
        description: activity.description,
        time: activity.time ?? null,
        images: (activity.mediaIds ?? []).map((mediaId: any) => ({ id: String(mediaId), url: `/api/media/public/${String(mediaId)}/content` })),
      })),
    }));
    return {
      id: String(row._id),
      title: row.title,
      countryIds: row.countryIds,
      startDate: row.startDate,
      endDate: row.endDate ?? null,
      author: { name: authors.get(String(row.ownerId)) ?? presentAuthor(null).name },
      ...(row.clonedFrom ? { clonedFrom: row.clonedFrom } : {}),
      days,
      cityGroups: cityGroups(row.days ?? [], row.startDate),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  /** Author names by owner id; a deactivated or missing account is "Deleted user". Never an id or e-mail. */
  private async authorNames(ownerIds: unknown[]) {
    const ids = [...new Set(ownerIds.map(String))];
    const users = ids.length
      ? await this.users.find({ _id: { $in: ids } }).select('name isActive deactivatedAt').lean().exec()
      : [];
    const names = new Map<string, string>();
    for (const id of ids) names.set(id, presentAuthor(users.find((user) => String(user._id) === id) as never).name);
    return names;
  }
}
