import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, PipelineStage, Types } from 'mongoose';

import { Flight, FlightStatus } from './schemas/flight.schema';
import {
  CabinClass,
  CabinInventory,
} from './schemas/cabin-inventory.schema';
import { Airline } from '../airlines/schemas/airline.schema';
import { Airport } from '../airports/schemas/airport.schema';

import {
  FlightSearchQueryDto,
  FlightSearchSortField,
  SortOrder,
} from './dto/flight-search.dto';
import {
  formatLocalDateTime,
  localDateToUtcRange,
} from './utils/local-time.util';

// GEN-05: Fixed page size
const PAGE_SIZE = 10;

// FLT-12: Infants pay 10% of the cabin fare
const INFANT_FARE_RATE = 0.1;

const NO_FLIGHTS_MESSAGE = 'No flights found';

type AirportInfo = Pick<
  Airport,
  'iataCode' | 'name' | 'city' | 'country' | 'timeZone'
>;

interface PassengerCounts {
  adults: number;
  children: number;
  infants: number;
}

interface CabinFilter {
  cabinClass?: CabinClass;
  minPrice?: number;
  maxPrice?: number;
}

interface ListSearch {
  origin: AirportInfo;
  destination: AirportInfo;
  localDate: string;
  page: number;
}

interface AggregatedCabin {
  _id: Types.ObjectId;
  cabinClass: CabinClass;
  price: number;
  currency: string;
  availableSeats: number;
  freeBagsCount: number;
}

interface AggregatedFlight {
  _id: Types.ObjectId;
  flightNumber: string;
  status: FlightStatus;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: Date;
  arrivalTime: Date;
  durationMinutes: number;
  lowestPrice: number;
  airline: { _id: Types.ObjectId; name: string; code: string };
  cabins: AggregatedCabin[];
}

const round2 = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;

@Injectable()
export class FlightSearchService {
  constructor(
    @InjectModel(Flight.name)
    private readonly flightModel: Model<Flight>,

    @InjectModel(CabinInventory.name)
    private readonly inventoryModel: Model<CabinInventory>,

    @InjectModel(Airline.name)
    private readonly airlineModel: Model<Airline>,

    @InjectModel(Airport.name)
    private readonly airportModel: Model<Airport>,
  ) {}

  // FLT-11 / FLT-12 / FLT-15: Public flight search
  async search(query: FlightSearchQueryDto) {
    const departureCode = query.departureAirport;
    const arrivalCode = query.arrivalAirport;

    if (departureCode === arrivalCode) {
      throw new BadRequestException(
        'Departure and arrival airports must differ',
      );
    }

    // FLT-12(b): At least one adult, and no more infants than adults
    if (query.adults < 1) {
      throw new BadRequestException('At least one adult is required');
    }

    if (query.infants > query.adults) {
      throw new BadRequestException(
        'The number of infants cannot exceed the number of adults',
      );
    }

    // FLT-15: Inclusive price range
    if (
      query.minPrice !== undefined &&
      query.maxPrice !== undefined &&
      query.minPrice > query.maxPrice
    ) {
      throw new BadRequestException(
        'minPrice cannot be greater than maxPrice',
      );
    }

    // FLT-12(a): Return date must not be before the departure date.
    // Both are YYYY-MM-DD, so string comparison is chronological.
    if (query.returnDate !== undefined && query.returnDate < query.departureDate) {
      throw new BadRequestException(
        'returnDate cannot be before departureDate',
      );
    }

    // One query for both airports (the route is the same for every result)
    const airports = await this.airportModel
      .find({ iataCode: { $in: [departureCode, arrivalCode] } })
      .select({ iataCode: 1, name: 1, city: 1, country: 1, timeZone: 1 })
      .lean<AirportInfo[]>()
      .exec();

    const origin = airports.find((a) => a.iataCode === departureCode);
    const destination = airports.find((a) => a.iataCode === arrivalCode);

    const unknown = [
      !origin ? departureCode : null,
      !destination ? arrivalCode : null,
    ].filter(Boolean);

    if (!origin || !destination) {
      throw new BadRequestException(
        `Unknown airport code: ${unknown.join(', ')}`,
      );
    }

    const passengers: PassengerCounts = {
      adults: query.adults,
      children: query.children,
      infants: query.infants,
    };

    const cabinFilter: CabinFilter = {
      cabinClass: query.cabinClass,
      minPrice: query.minPrice,
      maxPrice: query.maxPrice,
    };

    const searchList = (list: ListSearch) =>
      this.searchList(list, passengers, cabinFilter, query.sortBy, query.order);

    const outboundPromise = searchList({
      origin,
      destination,
      localDate: query.departureDate,
      page: query.outboundPage,
    });

    // FLT-12(a): Return leg uses the reversed route and the same rules
    const returnPromise =
      query.returnDate !== undefined
        ? searchList({
            origin: destination,
            destination: origin,
            localDate: query.returnDate,
            page: query.returnPage,
          })
        : Promise.resolve(undefined);

    const [outbound, inbound] = await Promise.all([
      outboundPromise,
      returnPromise,
    ]);

    return {
      tripType: inbound ? 'round-trip' : 'one-way',
      passengers: {
        ...passengers,
        // Infants take no seat
        seatsRequired: passengers.adults + passengers.children,
      },
      outbound,
      ...(inbound ? { return: inbound } : {}),
    };
  }

  // Searches one direction for one local date, paginated.
  private async searchList(
    list: ListSearch,
    passengers: PassengerCounts,
    cabinFilter: CabinFilter,
    sortBy: FlightSearchSortField,
    order: SortOrder,
  ) {
    const { origin, destination, localDate, page } = list;

    // FLT-11: Local day at the departure airport -> UTC range (DST-aware)
    const { start, end } = localDateToUtcRange(localDate, origin.timeZone);

    // FLT-30: Exclude flights whose departure time has already passed
    const now = new Date();
    const departureFrom = start > now ? start : now;

    const seatsRequired = passengers.adults + passengers.children;

    const cabinConditions: Record<string, unknown>[] = [
      { $expr: { $eq: ['$flightId', '$$flightId'] } },
      // FLT-11: Infants take no seat
      { availableSeats: { $gte: seatsRequired } },
    ];

    if (cabinFilter.cabinClass !== undefined) {
      cabinConditions.push({ cabinClass: cabinFilter.cabinClass });
    }

    if (cabinFilter.minPrice !== undefined) {
      cabinConditions.push({ price: { $gte: cabinFilter.minPrice } });
    }

    if (cabinFilter.maxPrice !== undefined) {
      cabinConditions.push({ price: { $lte: cabinFilter.maxPrice } });
    }

    const sortField = {
      price: 'lowestPrice',
      duration: 'durationMinutes',
      departureTime: 'departureTime',
    }[sortBy];
    const direction = order === 'desc' ? -1 : 1;

    const pipeline: PipelineStage[] = [
      {
        $match: {
          departureAirport: origin.iataCode,
          arrivalAirport: destination.iataCode,
          // FLT-30: Only Scheduled flights
          status: FlightStatus.SCHEDULED,
          departureTime: { $gte: departureFrom, $lt: end },
        },
      },
      // Only flights of active airlines
      {
        $lookup: {
          from: this.airlineModel.collection.name,
          localField: 'airlineId',
          foreignField: '_id',
          as: 'airline',
        },
      },
      { $unwind: '$airline' },
      { $match: { 'airline.isActive': true } },
      // Matching cabins only
      {
        $lookup: {
          from: this.inventoryModel.collection.name,
          let: { flightId: '$_id' },
          pipeline: [
            { $match: { $and: cabinConditions } },
            { $sort: { price: 1 } },
            {
              $project: {
                cabinClass: 1,
                price: 1,
                currency: 1,
                availableSeats: 1,
                freeBagsCount: 1,
              },
            },
          ],
          as: 'cabins',
        },
      },
      { $match: { 'cabins.0': { $exists: true } } },
      {
        $addFields: {
          // FLT-15: Price sort uses the cheapest matching cabin
          lowestPrice: { $min: '$cabins.price' },
          durationMinutes: {
            $round: [
              {
                $divide: [
                  { $subtract: ['$arrivalTime', '$departureTime'] },
                  60000,
                ],
              },
              0,
            ],
          },
        },
      },
      { $sort: { [sortField]: direction, _id: 1 } },
      {
        $facet: {
          items: [
            { $skip: (page - 1) * PAGE_SIZE },
            { $limit: PAGE_SIZE },
            {
              $project: {
                flightNumber: 1,
                status: 1,
                departureAirport: 1,
                arrivalAirport: 1,
                departureTime: 1,
                arrivalTime: 1,
                durationMinutes: 1,
                lowestPrice: 1,
                cabins: 1,
                'airline._id': 1,
                'airline.name': 1,
                'airline.code': 1,
              },
            },
          ],
          total: [{ $count: 'count' }],
        },
      },
    ];

    const [result] = await this.flightModel
      .aggregate<{ items: AggregatedFlight[]; total: { count: number }[] }>(
        pipeline,
      )
      .exec();

    const totalItems = result?.total[0]?.count ?? 0;
    const totalPages = Math.ceil(totalItems / PAGE_SIZE);

    const items = (result?.items ?? []).map((flight) =>
      this.toSearchResult(flight, origin, destination, passengers),
    );

    return {
      items,
      // GEN-05: Same pagination format as the hotels module
      pagination: {
        page,
        pageSize: PAGE_SIZE,
        totalItems,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      },
      ...(totalItems === 0 ? { message: NO_FLIGHTS_MESSAGE } : {}),
    };
  }

  private toSearchResult(
    flight: AggregatedFlight,
    origin: AirportInfo,
    destination: AirportInfo,
    passengers: PassengerCounts,
  ) {
    const airportInfo = (airport: AirportInfo) => ({
      iataCode: airport.iataCode,
      name: airport.name,
      city: airport.city,
      country: airport.country,
    });

    return {
      id: flight._id,
      flightNumber: flight.flightNumber,
      status: flight.status,
      airline: {
        id: flight.airline._id,
        name: flight.airline.name,
        code: flight.airline.code,
      },
      departureAirport: flight.departureAirport,
      arrivalAirport: flight.arrivalAirport,
      departureAirportDetails: airportInfo(origin),
      arrivalAirportDetails: airportInfo(destination),
      departureTime: flight.departureTime.toISOString(),
      departureTimeLocal: formatLocalDateTime(
        flight.departureTime,
        origin.timeZone,
      ),
      departureTimeZone: origin.timeZone,
      arrivalTime: flight.arrivalTime.toISOString(),
      arrivalTimeLocal: formatLocalDateTime(
        flight.arrivalTime,
        destination.timeZone,
      ),
      arrivalTimeZone: destination.timeZone,
      durationMinutes: flight.durationMinutes,
      lowestPrice: flight.lowestPrice,
      cabins: flight.cabins.map((cabin) =>
        this.toCabinResult(cabin, passengers),
      ),
    };
  }

  // FLT-12(b): Adults and children pay the fare; infants pay 10%
  private toCabinResult(cabin: AggregatedCabin, passengers: PassengerCounts) {
    const infantFare = round2(cabin.price * INFANT_FARE_RATE);
    const adultsSubtotal = round2(cabin.price * passengers.adults);
    const childrenSubtotal = round2(cabin.price * passengers.children);
    const infantsSubtotal = round2(infantFare * passengers.infants);

    return {
      id: cabin._id,
      cabinClass: cabin.cabinClass,
      price: cabin.price,
      currency: cabin.currency,
      availableSeats: cabin.availableSeats,
      freeBagsCount: cabin.freeBagsCount,
      priceBreakdown: {
        adults: {
          count: passengers.adults,
          unitPrice: cabin.price,
          subtotal: adultsSubtotal,
        },
        children: {
          count: passengers.children,
          unitPrice: cabin.price,
          subtotal: childrenSubtotal,
        },
        infants: {
          count: passengers.infants,
          unitPrice: infantFare,
          subtotal: infantsSubtotal,
        },
      },
      estimatedTotal: round2(
        adultsSubtotal + childrenSubtotal + infantsSubtotal,
      ),
    };
  }
}
