import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { fieldErrors, type FieldError } from '../../common/pipes/validation.pipe';
import { HotelBooking } from '../hotel-bookings/schemas/hotel-booking.schema';
import { City } from '../reference-data/schemas/city.schema';
import { Country } from '../reference-data/schemas/country.schema';
import { HotelSearchQueryDto, HotelSortBy, HotelSortOrder, RoomsAvailableQueryDto } from './dto/hotel-search.dto';
import { Hotel } from './schemas/hotel.schema';
import { Room } from './schemas/room.schema';
import { ActiveBooking, activeBookingsFilter, findFreeRooms, nightsBetween } from './room-availability';

/**
 * ONE search routine. A later task (ITN-25, hotels for an itinerary's city group) calls it with several cities.
 * `cityIds` and `countryCodes` are alternatives that are OR-ed when both are given.
 */
export interface HotelSearchCriteria {
  cityIds?: string[];
  countryCodes?: string[];
  checkIn: Date;
  checkOut: Date;
  guests: number;
  rooms: number;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  sortBy: HotelSortBy;
  order?: HotelSortOrder;
  page: number;
  limit: number;
}

const NO_HOTELS = 'No hotels found';
const round2 = (n: number) => Math.round(n * 100) / 100;
const utcDay = (value: string) => new Date(`${value}T00:00:00.000Z`);

@Injectable()
export class HotelSearchService {
  constructor(
    @InjectModel(Hotel.name) private readonly hotelModel: Model<Hotel>,
    @InjectModel(Room.name) private readonly roomModel: Model<Room>,
    @InjectModel(HotelBooking.name) private readonly bookingModel: Model<HotelBooking>,
    @InjectModel(City.name) private readonly cityModel: Model<City>,
    @InjectModel(Country.name) private readonly countryModel: Model<Country>,
  ) {}

  /** Cross-field stay rules shared by search and rooms/available. */
  private stayErrors(checkIn: string, checkOut: string): FieldError[] {
    const errors: FieldError[] = [];
    if (checkOut <= checkIn) errors.push({ field: 'checkOut', messages: ['checkOut must be after checkIn'] });
    // Hotels have no stored time zone, so "today" is the UTC date.
    const today = new Date().toISOString().slice(0, 10);
    if (checkIn < today) errors.push({ field: 'checkIn', messages: [`checkIn cannot be in the past (today is ${today}, UTC)`] });
    return errors;
  }

  /** GET /hotels/search */
  async searchFromQuery(q: HotelSearchQueryDto) {
    const errors = this.stayErrors(q.checkIn, q.checkOut);
    if (!q.city === !q.country) {
      const message = q.city ? 'Give either city or country, not both' : 'Give exactly one of city or country';
      errors.push({ field: 'city', messages: [message] }, { field: 'country', messages: [message] });
    }
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) {
      errors.push({ field: 'minPrice', messages: ['minPrice must not be greater than maxPrice'] });
    }
    if (errors.length) throw fieldErrors(errors);
    return this.search({
      cityIds: q.city ? [q.city] : undefined,
      countryCodes: q.country ? [q.country] : undefined,
      checkIn: utcDay(q.checkIn),
      checkOut: utcDay(q.checkOut),
      guests: q.guests,
      rooms: q.rooms,
      minPrice: q.minPrice,
      maxPrice: q.maxPrice,
      minRating: q.minRating,
      sortBy: q.sortBy,
      order: q.order,
      page: q.page,
      limit: q.limit,
    });
  }

  /**
   * Three batched queries (hotels, their rooms, the relevant reservations and holds), then the shared free-room rule
   * (room-availability.ts), THEN filter, sort and paginate, so pages and totals are exact. Doing it in memory over one
   * city or country is deliberate: the rule exists once, in code, and booking uses the same one.
   */
  async search(c: HotelSearchCriteria) {
    const nights = nightsBetween(c.checkIn, c.checkOut);
    const place: Record<string, unknown>[] = [];
    if (c.cityIds?.length) place.push({ cityId: { $in: c.cityIds } });
    if (c.countryCodes?.length) place.push({ countryId: { $in: c.countryCodes } });
    const hotelFilter: Record<string, unknown> = { isActive: true, ...(place.length > 1 ? { $or: place } : (place[0] ?? {})) };
    if (c.minRating !== undefined) hotelFilter.averageRating = { $gte: c.minRating }; // null (unrated) never matches

    const hotels = await this.hotelModel.find(hotelFilter).select('name cityId countryId starClass photos averageRating ratingCount').lean().exec();
    if (hotels.length === 0) return this.page([], c, nights);

    const rooms = await this.roomModel
      .find({
        hotelId: { $in: hotels.map((h) => h._id) },
        isActive: true,
        // cheap prefilter: some availability range must intersect the stay (the exact rule is applied below)
        availabilityRanges: { $elemMatch: { startDate: { $lt: c.checkOut }, endDate: { $gt: c.checkIn } } },
      })
      .select('hotelId name type beds maxOccupancy pricePerNight currency isActive availabilityRanges blockedRanges')
      .lean()
      .exec();
    const activeBookings = rooms.length
      ? ((await this.bookingModel
          .find(activeBookingsFilter(rooms.map((r) => r._id), c.checkIn, c.checkOut, new Date()))
          .select({ rooms: 1 })
          .lean()
          .exec()) as ActiveBooking[])
      : [];

    const freeByHotel = new Map<string, typeof rooms>();
    for (const room of findFreeRooms(rooms, activeBookings, c.checkIn, c.checkOut)) {
      const key = String(room.hotelId);
      freeByHotel.set(key, [...(freeByHotel.get(key) ?? []), room]);
    }

    const matches = hotels.flatMap((hotel) => {
      const free = freeByHotel.get(String(hotel._id)) ?? [];
      if (free.length < c.rooms) return [];
      // the best `rooms` rooms by capacity must hold everyone together
      const capacity = [...free].sort((a, b) => b.maxOccupancy - a.maxOccupancy).slice(0, c.rooms).reduce((sum, r) => sum + r.maxOccupancy, 0);
      if (capacity < c.guests) return [];
      const cheapest = free.reduce((best, r) => (r.pricePerNight < best.pricePerNight ? r : best));
      if (c.minPrice !== undefined && cheapest.pricePerNight < c.minPrice) return [];
      if (c.maxPrice !== undefined && cheapest.pricePerNight > c.maxPrice) return [];
      return [{ hotel, cheapest, freeRooms: free.length }];
    });

    const direction = (c.order ?? (c.sortBy === HotelSortBy.RATING ? HotelSortOrder.DESC : HotelSortOrder.ASC)) === HotelSortOrder.DESC ? -1 : 1;
    const rating = (m: (typeof matches)[number]) => m.hotel.averageRating ?? null;
    matches.sort((a, b) => {
      let diff = 0;
      if (c.sortBy === HotelSortBy.PRICE) diff = (a.cheapest.pricePerNight - b.cheapest.pricePerNight) * direction;
      else {
        const [ra, rb] = [rating(a), rating(b)];
        if (ra === null || rb === null) diff = ra === rb ? 0 : ra === null ? 1 : -1; // unrated last, whatever the order
        else diff = (ra - rb) * direction;
      }
      if (diff) return diff;
      // stable, predictable ties: cheaper, then better rated, then name, then id
      return (
        a.cheapest.pricePerNight - b.cheapest.pricePerNight ||
        (rating(b) ?? 0) - (rating(a) ?? 0) ||
        a.hotel.name.localeCompare(b.hotel.name) ||
        String(a.hotel._id).localeCompare(String(b.hotel._id))
      );
    });

    return this.page(matches, c, nights);
  }

  private async page(matches: Array<{ hotel: any; cheapest: any; freeRooms: number }>, c: HotelSearchCriteria, nights: number) {
    const total = matches.length;
    const slice = matches.slice((c.page - 1) * c.limit, c.page * c.limit);
    const [cities, countries] = slice.length
      ? await Promise.all([
          this.cityModel.find({ cityId: { $in: [...new Set(slice.map((m) => m.hotel.cityId))] } }).select('cityId name').lean().exec(),
          this.countryModel.find({ code: { $in: [...new Set(slice.map((m) => m.hotel.countryId))] } }).select('code name').lean().exec(),
        ])
      : [[], []];
    const cityName = new Map(cities.map((x) => [x.cityId, x.name]));
    const countryName = new Map(countries.map((x) => [x.code, x.name]));
    const items = slice.map(({ hotel, cheapest, freeRooms }) => ({
      id: String(hotel._id),
      name: hotel.name,
      starClass: hotel.starClass,
      photo: hotel.photos?.[0] ?? null,
      city: { city_id: hotel.cityId, name: cityName.get(hotel.cityId) ?? hotel.cityId },
      country: { code: hotel.countryId, name: countryName.get(hotel.countryId) ?? hotel.countryId },
      averageRating: hotel.averageRating ?? null,
      ratingCount: hotel.ratingCount ?? 0,
      cheapestPricePerNight: cheapest.pricePerNight,
      currency: cheapest.currency,
      freeRooms,
      nights,
    }));
    return { items, page: c.page, limit: c.limit, total, pages: Math.ceil(total / c.limit), ...(total === 0 ? { message: NO_HOTELS } : {}) };
  }

  /** GET /hotels/:hotelId/rooms/available (HTL-15): every free room, with the total price of the stay. */
  async availableRooms(hotelId: string, query: RoomsAvailableQueryDto) {
    const errors = this.stayErrors(query.checkIn, query.checkOut);
    if (!Types.ObjectId.isValid(hotelId)) errors.unshift({ field: 'hotelId', messages: ['hotelId must be a valid hotel id'] });
    if (errors.length) throw fieldErrors(errors);

    const hotel = await this.hotelModel.findOne({ _id: hotelId, isActive: true }).select('_id').lean().exec();
    if (!hotel) throw new NotFoundException('Hotel not found');

    const checkIn = utcDay(query.checkIn);
    const checkOut = utcDay(query.checkOut);
    const nights = nightsBetween(checkIn, checkOut);
    const rooms = await this.roomModel.find({ hotelId: hotel._id, isActive: true }).lean().exec();
    const activeBookings = rooms.length
      ? ((await this.bookingModel
          .find(activeBookingsFilter(rooms.map((r) => r._id), checkIn, checkOut, new Date()))
          .select({ rooms: 1 })
          .lean()
          .exec()) as ActiveBooking[])
      : [];
    const items = findFreeRooms(rooms, activeBookings, checkIn, checkOut)
      .sort((a, b) => a.pricePerNight - b.pricePerNight || a.name.localeCompare(b.name))
      .map((room) => ({
        id: String(room._id),
        name: room.name,
        type: room.type,
        beds: room.beds,
        maxOccupancy: room.maxOccupancy,
        pricePerNight: room.pricePerNight,
        currency: room.currency,
        nights,
        totalPrice: round2(nights * room.pricePerNight),
      }));
    return { hotelId: String(hotel._id), checkIn: query.checkIn, checkOut: query.checkOut, nights, items, ...(items.length === 0 ? { message: 'No rooms available for these dates' } : {}) };
  }
}
