import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FxRatesService } from '../../integrations/fx-rates/fx-rates.service';
import { UsersService } from '../users/users.service';
import { UpdateItineraryDto } from './dto/itineraries.dto';
import { BudgetCategory } from './schemas/budget.schema';
import { Itinerary } from './schemas/itinerary.schema';

export interface ItineraryCityGroup {
  cityId: string;
  dayNumbers: number[];
  dayCount: number;
  budgetSubtotals: Record<string, number>;
}

interface ItineraryBudgetLine {
  category: string;
  dayNumber: number;
  amount: number;
  currency: string;
}

interface ItineraryDayBudgetSummary {
  dayNumber: number;
  date: string;
  categories: Record<string, number>;
  total: number;
}

function groupConsecutiveDaysByCity(
  days: Itinerary['days'],
): ItineraryCityGroup[] {
  const orderedDays = [...days].sort(
    (first, second) => first.dayNumber - second.dayNumber,
  );

  const groups: ItineraryCityGroup[] = [];

  for (const day of orderedDays) {
    const cityId = day.cityId.toString();
    const lastGroup = groups[groups.length - 1];
    const daySubtotals: Record<string, number> = {};

    for (const budget of day.budgets ?? []) {
      const currency = budget.currency.toUpperCase();
      daySubtotals[currency] =
        (daySubtotals[currency] ?? 0) + budget.amount;
    }

    if (lastGroup && lastGroup.cityId === cityId) {
      lastGroup.dayNumbers.push(day.dayNumber);
      lastGroup.dayCount += 1;

      for (const [currency, amount] of Object.entries(daySubtotals)) {
        lastGroup.budgetSubtotals[currency] =
          (lastGroup.budgetSubtotals[currency] ?? 0) + amount;
      }
    } else {
      groups.push({
        cityId,
        dayNumbers: [day.dayNumber],
        dayCount: 1,
        budgetSubtotals: daySubtotals,
      });
    }
  }

  return groups;
}

function getDateForDay(startDate: Date, dayNumber: number): string {
  const date = new Date(startDate);
  date.setUTCDate(date.getUTCDate() + dayNumber - 1);
  return date.toISOString().slice(0, 10);
}

function roundAmount(amount: number): number {
  return Number(amount.toFixed(2));
}

@Injectable()
export class ItinerariesService {
  constructor(
    @InjectModel(Itinerary.name)
    private readonly itineraryModel: Model<Itinerary>,
    private readonly fxRatesService: FxRatesService,
    private readonly usersService: UsersService,
  ) {}

  private withDerivedDayDates<
    T extends { startDate: Date; days: Itinerary['days'] },
  >(itinerary: T) {
    const days = itinerary.days.map((day) => ({
      ...day,
      date: getDateForDay(itinerary.startDate, day.dayNumber),
    }));

    return {
      ...itinerary,
      days,
      cityGroups: groupConsecutiveDaysByCity(days),
    };
  }

  async findMine(ownerId: string) {
    if (!Types.ObjectId.isValid(ownerId)) {
      throw new BadRequestException('Invalid user ID');
    }

    const itineraries = await this.itineraryModel
      .find({ ownerId: new Types.ObjectId(ownerId) })
      .select('title countryIds startDate days visibility updatedAt')
      .sort({ updatedAt: -1 })
      .lean()
      .exec();

    return itineraries.map((itinerary) =>
      this.withDerivedDayDates(itinerary),
    );
  }

  async findMineById(itineraryId: string, ownerId: string) {
    if (
      !Types.ObjectId.isValid(itineraryId) ||
      !Types.ObjectId.isValid(ownerId)
    ) {
      throw new BadRequestException('Invalid itinerary or user ID');
    }

    const itinerary = await this.itineraryModel
      .findOne({
        _id: new Types.ObjectId(itineraryId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .lean()
      .exec();

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found');
    }

    return this.withDerivedDayDates(itinerary);
  }

  async update(
    itineraryId: string,
    dto: UpdateItineraryDto,
    ownerId: string,
  ) {
    if (
      !Types.ObjectId.isValid(itineraryId) ||
      !Types.ObjectId.isValid(ownerId)
    ) {
      throw new BadRequestException('Invalid itinerary or user ID');
    }

    const itinerary = await this.itineraryModel
      .findOne({
        _id: new Types.ObjectId(itineraryId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .exec();

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found');
    }

    if (dto.title !== undefined) {
      itinerary.title = dto.title;
    }

    if (dto.countryIds !== undefined) {
      itinerary.countryIds = dto.countryIds.map(
        (countryId) => new Types.ObjectId(countryId),
      );
    }

    if (dto.startDate !== undefined) {
      itinerary.startDate = new Date(dto.startDate);
    }

    if (dto.visibility !== undefined) {
      itinerary.visibility = dto.visibility;
    }

    await itinerary.save();
    return this.withDerivedDayDates(itinerary.toObject());
  }

  async getBudgetSummary(
    itineraryId: string,
    ownerId: string,
  ) {
    if (
      !Types.ObjectId.isValid(itineraryId) ||
      !Types.ObjectId.isValid(ownerId)
    ) {
      throw new BadRequestException('Invalid itinerary or user ID');
    }

    const itinerary = await this.itineraryModel
      .findOne({
        _id: new Types.ObjectId(itineraryId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .lean()
      .exec();

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found');
    }

    const user = await this.usersService.getProfile(ownerId);
    const preferredCurrency = user.preferredCurrency
      .trim()
      .toUpperCase();

    const lines: ItineraryBudgetLine[] = [];
    const dayNumberById = new Map<string, number>();

    for (const day of itinerary.days) {
      const dayId = (
        day as unknown as { _id?: Types.ObjectId }
      )._id;

      if (dayId) {
        dayNumberById.set(dayId.toString(), day.dayNumber);
      }

      for (const budget of day.budgets ?? []) {
        lines.push({
          category: budget.category,
          dayNumber: day.dayNumber,
          amount: budget.amount,
          currency: budget.currency.toUpperCase(),
        });
      }

      for (const activity of day.activities ?? []) {
        if (activity.cost === undefined || activity.cost === null) {
          continue;
        }

        if (!activity.costCurrency) {
          throw new BadRequestException(
            `Activity "${activity.name}" has a cost but no cost currency`,
          );
        }

        lines.push({
          category: BudgetCategory.ACTIVITIES,
          dayNumber: day.dayNumber,
          amount: activity.cost,
          currency: activity.costCurrency.toUpperCase(),
        });
      }
    }

    for (const transportCost of itinerary.transportCosts ?? []) {
      const dayNumber = dayNumberById.get(
        transportCost.dayId.toString(),
      );

      if (dayNumber === undefined) {
        throw new BadRequestException(
          'A transport cost refers to a day that is not in this itinerary',
        );
      }

      lines.push({
        category: 'intercity_transport',
        dayNumber,
        amount: transportCost.amount,
        currency: transportCost.currency.toUpperCase(),
      });
    }

    const sourceCurrencies = [
      ...new Set(lines.map((line) => line.currency)),
    ];

    const ratesByCurrency: Record<
      string,
      {
        rate: number;
        rateDate: string | null;
        stale: boolean;
      }
    > = {};

    for (const currency of sourceCurrencies) {
      const quote = await this.fxRatesService.getRate(
        currency,
        preferredCurrency,
      );

      ratesByCurrency[currency] = {
        rate: quote.rate,
        rateDate:
          'fetchedAt' in quote ? quote.fetchedAt ?? null : null,
        stale: quote.stale,
      };
    }

    const totalsByCategory: Record<string, number> = {};
    const originalTotalsByCurrency: Record<string, number> = {};
    const totalsByDay = new Map<number, ItineraryDayBudgetSummary>();

    for (const day of itinerary.days) {
      totalsByDay.set(day.dayNumber, {
        dayNumber: day.dayNumber,
        date: getDateForDay(itinerary.startDate, day.dayNumber),
        categories: {},
        total: 0,
      });
    }

    for (const line of lines) {
      const rate = ratesByCurrency[line.currency]?.rate;

      if (rate === undefined) {
        throw new BadRequestException(
          `No exchange rate is available for ${line.currency}`,
        );
      }

      const convertedAmount = line.amount * rate;
      const daySummary = totalsByDay.get(line.dayNumber);

      if (!daySummary) {
        throw new BadRequestException(
          'A budget entry refers to a day that is not in this itinerary',
        );
      }

      totalsByCategory[line.category] =
        (totalsByCategory[line.category] ?? 0) + convertedAmount;

      daySummary.categories[line.category] =
        (daySummary.categories[line.category] ?? 0) +
        convertedAmount;

      daySummary.total += convertedAmount;

      originalTotalsByCurrency[line.currency] =
        (originalTotalsByCurrency[line.currency] ?? 0) +
        line.amount;
    }

    const roundedCategoryTotals = Object.fromEntries(
      Object.entries(totalsByCategory).map(([category, amount]) => [
        category,
        roundAmount(amount),
      ]),
    );

    const roundedDayTotals = [...totalsByDay.values()]
      .sort((first, second) => first.dayNumber - second.dayNumber)
      .map((day) => ({
        ...day,
        categories: Object.fromEntries(
          Object.entries(day.categories).map(([category, amount]) => [
            category,
            roundAmount(amount),
          ]),
        ),
        total: roundAmount(day.total),
      }));

    const grandTotal = Object.values(totalsByCategory).reduce(
      (total, amount) => total + amount,
      0,
    );

    return {
      itineraryId: itinerary._id.toString(),
      preferredCurrency,
      rateDate: ratesByCurrency,
      originalTotalsByCurrency: Object.fromEntries(
        Object.entries(originalTotalsByCurrency).map(
          ([currency, amount]) => [currency, roundAmount(amount)],
        ),
      ),
      totalsByCategory: roundedCategoryTotals,
      totalsByDay: roundedDayTotals,
      grandTotal: roundAmount(grandTotal),
    };
  }

  async deleteDay(
    itineraryId: string,
    dayId: string,
    ownerId: string,
  ) {
    if (
      !Types.ObjectId.isValid(itineraryId) ||
      !Types.ObjectId.isValid(dayId) ||
      !Types.ObjectId.isValid(ownerId)
    ) {
      throw new BadRequestException(
        'Invalid itinerary, day or user ID',
      );
    }

    const itinerary = await this.itineraryModel
      .findOne({
        _id: new Types.ObjectId(itineraryId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .exec();

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found');
    }

    const dayIndex = itinerary.days.findIndex((day) => {
      const embeddedDay = day as unknown as {
        _id: Types.ObjectId;
      };

      return embeddedDay._id.toString() === dayId;
    });

    if (dayIndex === -1) {
      throw new NotFoundException('Day not found');
    }

    itinerary.days.splice(dayIndex, 1);

    itinerary.days.forEach((day, index) => {
      day.dayNumber = index + 1;
    });

    await itinerary.save();
    return this.withDerivedDayDates(itinerary.toObject());
  }

  async reorderDay(
    itineraryId: string,
    dayId: string,
    newPosition: number,
    ownerId: string,
  ) {
    if (
      !Types.ObjectId.isValid(itineraryId) ||
      !Types.ObjectId.isValid(dayId) ||
      !Types.ObjectId.isValid(ownerId)
    ) {
      throw new BadRequestException(
        'Invalid itinerary, day or user ID',
      );
    }

    if (!Number.isInteger(newPosition) || newPosition < 1) {
      throw new BadRequestException(
        'New day position must be a positive integer',
      );
    }

    const itinerary = await this.itineraryModel
      .findOne({
        _id: new Types.ObjectId(itineraryId),
        ownerId: new Types.ObjectId(ownerId),
      })
      .exec();

    if (!itinerary) {
      throw new NotFoundException('Itinerary not found');
    }

    const currentIndex = itinerary.days.findIndex((day) => {
      const embeddedDay = day as unknown as {
        _id: Types.ObjectId;
      };

      return embeddedDay._id.toString() === dayId;
    });

    if (currentIndex === -1) {
      throw new NotFoundException('Day not found');
    }

    if (newPosition > itinerary.days.length) {
      throw new BadRequestException(
        'New day position is outside the itinerary',
      );
    }

    const [day] = itinerary.days.splice(currentIndex, 1);
    itinerary.days.splice(newPosition - 1, 0, day);

    itinerary.days.forEach((itineraryDay, index) => {
      itineraryDay.dayNumber = index + 1;
    });

    await itinerary.save();
    return this.withDerivedDayDates(itinerary.toObject());
  }
}