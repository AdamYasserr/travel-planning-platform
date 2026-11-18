import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';

import { fieldErrors } from '../../common/pipes/validation.pipe';
import { FlightSearchService } from '../flights/flight-search.service';
import { HotelSearchService } from '../hotels/hotel-search.service';
import { ItineraryFlightSearchQueryDto, ItineraryHotelSearchQueryDto } from './dto/itinerary-search.dto';
import { addDaysToIso, cityGroups, pickCityGroup } from './itinerary-days';
import { Itinerary } from './schemas/itinerary.schema';

/**
 * ITN-25 / ITN-26: the hotel and flight searches scoped to an itinerary. They only work out the city and the dates
 * from the itinerary's city groups; the searching itself is HotelSearchService and FlightSearchService, so
 * availability, pricing, sorting and paging are exactly those of GET /hotels/search and GET /flights/search.
 * Only the itinerary's owner can use them (anyone else: 404, like every itinerary route).
 */
@Injectable()
export class ItinerarySearchService {
  constructor(
    @InjectModel(Itinerary.name) private readonly itineraries: Model<Itinerary>,
    private readonly hotelSearch: HotelSearchService,
    private readonly flightSearch: FlightSearchService,
  ) {}

  async hotels(ownerId: string, id: string, query: ItineraryHotelSearchQueryDto) {
    const { groups, picked } = await this.groupOf(ownerId, id, query);
    const { index, group } = picked;
    const lastNight = addDaysToIso(group.endDate, 1);
    const checkIn = query.checkIn ?? group.startDate;
    const checkOut = query.checkOut ?? lastNight;
    const errors = [];
    if (checkIn < group.startDate) errors.push({ field: 'checkIn', messages: [`checkIn must not be before the group's first day (${group.startDate})`] });
    if (checkIn > lastNight) errors.push({ field: 'checkIn', messages: [`checkIn must not be after ${lastNight}`] });
    if (checkOut > lastNight) errors.push({ field: 'checkOut', messages: [`checkOut must not be after the day after the group's last day (${lastNight})`] });
    if (errors.length) throw fieldErrors(errors);

    const { group: _group, city: _city, checkIn: _in, checkOut: _out, ...filters } = query;
    const result = await this.hotelSearch.searchFromQuery({ ...filters, city: group.cityId, checkIn, checkOut } as never);
    return {
      itineraryId: id,
      context: { group: index, groups: groups.length, cityId: group.cityId, checkIn, checkOut },
      ...result,
    };
  }

  async flights(ownerId: string, id: string, query: ItineraryFlightSearchQueryDto) {
    const { groups, picked } = await this.groupOf(ownerId, id, query);
    const { index, group } = picked;
    const fromCity = query.fromCity ?? (index > 1 ? groups[index - 2].cityId : undefined);
    const date = query.date ?? group.startDate;
    const errors = [];
    if (!fromCity) errors.push({ field: 'fromCity', messages: ['fromCity is required for the first city group (there is no earlier city)'] });
    else if (fromCity === group.cityId) errors.push({ field: 'fromCity', messages: [`fromCity must differ from the destination city (${group.cityId})`] });
    if (date > group.startDate || date < addDaysToIso(group.startDate, -1)) {
      errors.push({ field: 'date', messages: [`date must be the group's first day (${group.startDate}) or the day before`] });
    }
    if (errors.length) throw fieldErrors(errors);

    const { group: _group, city: _city, fromCity: _from, date: _date, ...filters } = query;
    const result = await this.flightSearch.searchBetweenCities({
      ...filters,
      originCityId: fromCity!,
      destinationCityId: group.cityId,
      departureDate: date,
    });
    return {
      itineraryId: id,
      context: { group: index, groups: groups.length, fromCity: fromCity!, toCity: group.cityId, date },
      ...result,
    };
  }

  /** The owner's itinerary (404 for anyone else) and the city group the query points at (400 when it does not exist). */
  private async groupOf(ownerId: string, id: string, choice: { group?: number; city?: string }) {
    if (!isValidObjectId(id) || !isValidObjectId(ownerId)) throw new BadRequestException('Invalid MongoDB ID');
    const itinerary: any = await this.itineraries
      .findOne({ _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) })
      .select({ startDate: 1, 'days._id': 1, 'days.dayNumber': 1, 'days.cityId': 1 })
      .lean()
      .exec();
    if (!itinerary) throw new NotFoundException('Itinerary not found');
    const groups = cityGroups(itinerary.days ?? [], itinerary.startDate);
    const picked = pickCityGroup(groups, choice);
    if ('field' in picked) throw fieldErrors([{ field: picked.field, messages: [picked.message] }]);
    return { groups, picked };
  }
}
