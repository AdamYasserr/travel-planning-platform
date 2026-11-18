import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';

import { fieldErrors, type FieldError } from '../../common/pipes/validation.pipe';
import { Airline } from '../airlines/schemas/airline.schema';
import { BaggagePolicy } from '../airlines/schemas/baggage-policy.schema';
import { CancellationPolicy } from '../airlines/schemas/cancellation-policy.schema';
import { Airport } from '../airports/schemas/airport.schema';
import { City } from '../reference-data/schemas/city.schema';
import { FlightSearchQueryDto, FlightSortBy, SortOrder } from './dto/flight-search.dto';
import { CabinInventory, CabinClass } from './schemas/cabin-inventory.schema';
import { Flight, FlightStatus } from './schemas/flight.schema';
import { localDateInZone, localDayRangeUtc, toLocalInstant } from './timezone.util';

/** FLT-12(b): infants pay this share of the cabin fare and take no seat. */
export const INFANT_FARE_SHARE = 0.1;

export interface AirportRef {
  iataCode: string;
  timeZone: string;
}

/**
 * The one search routine. It takes LISTS of airports so a later "any airport in a city" search can reuse it:
 * pass every airport of the city. `localDate` is the local calendar day at EACH departure airport.
 */
export interface FlightSearchCriteria {
  originAirports: AirportRef[];
  destinationAirports: string[];
  localDate: string;
  adults: number;
  children: number;
  infants: number;
  cabinClass?: CabinClass;
  minPrice?: number;
  maxPrice?: number;
  airlineId?: string;
  sortBy: FlightSortBy;
  order: SortOrder;
  page: number;
  limit: number;
  /** Only flights departing after this instant (used to keep return flights after the outbound arrival). */
  departureAfter?: Date;
}

export interface FlightSearchPage {
  items: unknown[];
  page: number;
  limit: number;
  total: number;
  pages: number;
  message?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const NO_FLIGHTS = 'No flights found';

@Injectable()
export class FlightSearchService {
  constructor(
    @InjectModel(Flight.name) private readonly flightModel: Model<Flight>,
    @InjectModel(Airline.name) private readonly airlineModel: Model<Airline>,
    @InjectModel(CabinInventory.name) private readonly cabinModel: Model<CabinInventory>,
    @InjectModel(Airport.name) private readonly airportModel: Model<Airport>,
    @InjectModel(City.name) private readonly cityModel: Model<City>,
    @InjectModel(BaggagePolicy.name) private readonly baggageModel: Model<BaggagePolicy>,
    @InjectModel(CancellationPolicy.name) private readonly cancellationModel: Model<CancellationPolicy>,
  ) {}

  /** GET /flights/search: validates the cross-field rules, then runs the outbound (and return) search. */
  async searchFromQuery(query: FlightSearchQueryDto) {
    const errors: FieldError[] = [];
    if (query.origin === query.destination) errors.push({ field: 'destination', messages: ['destination must differ from origin'] });
    if (query.infants > query.adults) errors.push({ field: 'infants', messages: ['infants must not exceed adults: each infant needs an adult'] });
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      errors.push({ field: 'minPrice', messages: ['minPrice must not be greater than maxPrice'] });
    }
    if (query.returnDate && query.returnDate < query.departureDate) {
      errors.push({ field: 'returnDate', messages: ['returnDate must not be before departureDate'] });
    }

    const airports = await this.airportModel.find({ iataCode: { $in: [query.origin, query.destination] } }).lean().exec();
    const origin = airports.find((a) => a.iataCode === query.origin);
    const destination = airports.find((a) => a.iataCode === query.destination);
    if (!origin) errors.push({ field: 'origin', messages: [`Unknown airport ${query.origin}. Use an iata_code from GET /airports`] });
    if (!destination && query.destination !== query.origin) {
      errors.push({ field: 'destination', messages: [`Unknown airport ${query.destination}. Use an iata_code from GET /airports`] });
    }
    // "Past" is judged by today's date AT THE ORIGIN AIRPORT, not on the server.
    if (origin && query.departureDate < localDateInZone(new Date(), origin.timeZone)) {
      errors.push({ field: 'departureDate', messages: [`departureDate must not be in the past (today at ${origin.iataCode} is ${localDateInZone(new Date(), origin.timeZone)})`] });
    }
    if (errors.length) throw fieldErrors(errors);

    const common = {
      adults: query.adults, children: query.children, infants: query.infants, cabinClass: query.cabinClass,
      minPrice: query.minPrice, maxPrice: query.maxPrice, airlineId: query.airlineId,
      sortBy: query.sortBy, order: query.order, page: query.page, limit: query.limit,
    };
    const { earliestArrival, ...outbound } = await this.search({
      ...common,
      originAirports: [{ iataCode: origin!.iataCode, timeZone: origin!.timeZone }],
      destinationAirports: [destination!.iataCode],
      localDate: query.departureDate,
    });
    if (!query.returnDate) return { outbound, return: null };

    // Return flights go back destination -> origin, on returnDate (local date at the destination), and must
    // depart after the earliest outbound arrival. Pairing a specific outbound with a return is the booking task.
    if (!earliestArrival) {
      return { outbound, return: { items: [], page: query.page, limit: query.limit, total: 0, pages: 0, message: NO_FLIGHTS } };
    }
    const { earliestArrival: _ignored, ...back } = await this.search({
      ...common,
      originAirports: [{ iataCode: destination!.iataCode, timeZone: destination!.timeZone }],
      destinationAirports: [origin!.iataCode],
      localDate: query.returnDate,
      departureAfter: earliestArrival,
    });
    return { outbound, return: back };
  }

  async search(c: FlightSearchCriteria): Promise<FlightSearchPage & { earliestArrival: Date | null }> {
    const seatsNeeded = c.adults + c.children;
    const now = new Date();
    const lowerBound = c.departureAfter && c.departureAfter > now ? c.departureAfter : now;

    const zones = new Map<string, string[]>();
    for (const airport of c.originAirports) zones.set(airport.timeZone, [...(zones.get(airport.timeZone) ?? []), airport.iataCode]);
    const dayClauses = [...zones].map(([timeZone, codes]) => {
      const { start, end } = localDayRangeUtc(c.localDate, timeZone);
      return { departureAirport: { $in: codes }, departureTime: { $gte: start, $lt: end } };
    });

    const match: Record<string, unknown> = {
      departureAirport: { $in: c.originAirports.map((a) => a.iataCode) },
      arrivalAirport: { $in: c.destinationAirports },
      status: FlightStatus.SCHEDULED,
      $and: [{ departureTime: { $gt: lowerBound } }, { $or: dayClauses }],
    };
    if (c.airlineId) match.airlineId = new Types.ObjectId(c.airlineId);

    const cabinMatch: Record<string, unknown> = { $expr: { $eq: ['$flightId', '$$flightId'] }, availableSeats: { $gte: seatsNeeded } };
    if (c.cabinClass) cabinMatch.cabinClass = c.cabinClass;
    if (c.minPrice !== undefined || c.maxPrice !== undefined) {
      cabinMatch.price = { ...(c.minPrice !== undefined ? { $gte: c.minPrice } : {}), ...(c.maxPrice !== undefined ? { $lte: c.maxPrice } : {}) };
    }

    const sortField = { [FlightSortBy.PRICE]: 'fromPrice', [FlightSortBy.DURATION]: 'durationMs', [FlightSortBy.DEPARTURE]: 'departureTime' }[c.sortBy];
    const direction = c.order === SortOrder.DESC ? -1 : 1;
    const pipeline: PipelineStage[] = [
      { $match: match },
      { $lookup: { from: this.airlineModel.collection.name, localField: 'airlineId', foreignField: '_id', as: 'airline' } },
      { $unwind: '$airline' },
      { $match: { 'airline.isActive': true } },
      { $lookup: { from: this.cabinModel.collection.name, let: { flightId: '$_id' }, pipeline: [{ $match: cabinMatch }], as: 'cabins' } },
      { $match: { 'cabins.0': { $exists: true } } },
      { $addFields: { durationMs: { $subtract: ['$arrivalTime', '$departureTime'] }, fromPrice: { $min: '$cabins.price' } } },
      // The requested key first; ties by departure time then id, so paging is stable (never overriding the requested key).
      { $sort: sortField === 'departureTime' ? { departureTime: direction, _id: 1 } : { [sortField]: direction, departureTime: 1, _id: 1 } },
      {
        $facet: {
          rows: [{ $skip: (c.page - 1) * c.limit }, { $limit: c.limit }],
          meta: [{ $group: { _id: null, total: { $sum: 1 }, earliestArrival: { $min: '$arrivalTime' } } }],
        },
      },
    ];
    const [result] = await this.flightModel.aggregate(pipeline).exec();
    const meta = result?.meta?.[0] ?? { total: 0, earliestArrival: null };
    const rows: any[] = result?.rows ?? [];

    const lookups = await this.airportLookups(rows.flatMap((r) => [r.departureAirport, r.arrivalAirport]));
    const items = rows.map((row) => ({
      ...this.presentLeg(row, row.airline, lookups),
      cabins: [...row.cabins]
        .sort((a, b) => a.price - b.price)
        .map((cabin) => ({
          // FLT-12: the cabin id can be sent as outbound.cabinId / return.cabinId when booking.
          id: String(cabin._id),
          cabinClass: cabin.cabinClass,
          price: cabin.price,
          currency: cabin.currency,
          seatsRemaining: cabin.availableSeats,
          baggage: { freeBags: cabin.freeBagsCount, maxWeightPerBagKg: cabin.maxWeightPerBagKg },
          // FLT-12(b): adults and children pay the fare; infants pay 10% and take no seat.
          estimatedTotal: round2(seatsNeeded * cabin.price + c.infants * cabin.price * INFANT_FARE_SHARE),
        })),
    }));
    return {
      items, page: c.page, limit: c.limit, total: meta.total, pages: Math.ceil(meta.total / c.limit),
      ...(meta.total === 0 ? { message: NO_FLIGHTS } : {}),
      earliestArrival: meta.earliestArrival ?? null,
    };
  }

  /** FLT-17: details with every cabin, the airline's cancellation policy and baggage policy. */
  async details(id: string) {
    if (!Types.ObjectId.isValid(id)) throw fieldErrors([{ field: 'id', messages: ['id must be a valid flight id'] }]);
    const flight: any = await this.flightModel.findById(id).lean().exec();
    if (!flight) throw new NotFoundException('Flight not found');
    const [airline, cabins, cancellation, baggage] = await Promise.all([
      this.airlineModel.findById(flight.airlineId).lean().exec(),
      this.cabinModel.find({ flightId: flight._id }).sort({ price: 1 }).lean().exec(),
      this.cancellationModel.findOne({ airlineId: flight.airlineId }).lean().exec(),
      this.baggageModel.findOne({ airlineId: flight.airlineId }).lean().exec(),
    ]);
    const lookups = await this.airportLookups([flight.departureAirport, flight.arrivalAirport]);
    const bookable = flight.status === FlightStatus.SCHEDULED && flight.departureTime > new Date() && airline?.isActive === true;
    return {
      ...this.presentLeg(flight, airline, lookups),
      bookable,
      cabins: cabins.map((cabin: any) => ({
        id: String(cabin._id),
        cabinClass: cabin.cabinClass,
        price: cabin.price,
        currency: cabin.currency,
        totalSeats: cabin.totalSeats,
        seatsRemaining: cabin.availableSeats,
        baggage: { freeBags: cabin.freeBagsCount, maxWeightPerBagKg: cabin.maxWeightPerBagKg },
      })),
      cancellationPolicy: cancellation
        ? { tiers: [...cancellation.tiers].sort((a, b) => b.daysBeforeDeparture - a.daysBeforeDeparture).map((t) => ({ daysBeforeDeparture: t.daysBeforeDeparture, refundPercentage: t.refundPercentage })), description: cancellation.description }
        : null,
      baggagePolicy: baggage
        ? {
            carryOnAllowanceKg: baggage.carryOnAllowanceKg,
            checkedBaggageAllowanceKg: baggage.checkedBaggageAllowanceKg,
            pricePerExtraBag: baggage.pricePerExtraBag,
            maxExtraBagsPerPassenger: baggage.maxExtraBagsPerPassenger,
            currency: baggage.currency,
          }
        : null,
    };
  }

  private async airportLookups(codes: string[]) {
    const unique = [...new Set(codes)];
    const airports = await this.airportModel.find({ iataCode: { $in: unique } }).lean().exec();
    const cities = await this.cityModel.find({ cityId: { $in: [...new Set(airports.map((a) => a.cityId))] } }).select('cityId name').lean().exec();
    const cityName = new Map(cities.map((c) => [c.cityId, c.name]));
    return new Map(airports.map((a) => [a.iataCode, { iata_code: a.iataCode, name: a.name, city: cityName.get(a.cityId) ?? a.cityId, city_id: a.cityId, time_zone: a.timeZone }]));
  }

  /** Common view of a flight: airline, airports and times in each airport's local zone AND in UTC (GEN-06). */
  private presentLeg(flight: any, airline: any, lookups: Map<string, { time_zone: string }>) {
    const from: any = lookups.get(flight.departureAirport) ?? { iata_code: flight.departureAirport, time_zone: 'UTC' };
    const to: any = lookups.get(flight.arrivalAirport) ?? { iata_code: flight.arrivalAirport, time_zone: 'UTC' };
    return {
      id: String(flight._id),
      flightNumber: flight.flightNumber,
      status: flight.status,
      airline: airline ? { id: String(airline._id), name: airline.name, code: airline.code, logo: airline.logo ?? null } : null,
      departure: { airport: from, ...toLocalInstant(flight.departureTime, from.time_zone) },
      arrival: { airport: to, ...toLocalInstant(flight.arrivalTime, to.time_zone) },
      durationMinutes: Math.round((flight.arrivalTime.getTime() - flight.departureTime.getTime()) / 60000),
    };
  }
}
