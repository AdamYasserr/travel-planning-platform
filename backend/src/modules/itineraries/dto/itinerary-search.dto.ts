import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, Matches, Min } from 'class-validator';

import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';
import { FlightSearchQueryDto } from '../../flights/dto/flight-search.dto';
import { HotelSearchQueryDto } from '../../hotels/dto/hotel-search.dto';
import { DATASET_ID_PATTERN } from '../../reference-data/dto/reference-query.dto';

const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

/** Which city group of the itinerary a search is about: `group` (1-based) or `city` (its first group); default: group 1. */
export class CityGroupChoiceDto {
  @ApiPropertyOptional({ minimum: 1, description: 'Number of the city group in GET /itineraries/:id (cityGroups), starting at 1. Default 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  group?: number;

  @ApiPropertyOptional({ example: 'cairo', description: "A city_id of one of the itinerary's days: its first city group" })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'city must be a city_id such as cairo or new_york' })
  city?: string;
}

/**
 * ITN-25: the hotel search (GET /hotels/search) for a city group of the itinerary. The city and the stay come from the
 * itinerary (check-in = the group's first day, check-out = the day after its last day); every other filter is the
 * hotel search's own.
 */
export class ItineraryHotelSearchQueryDto extends OmitType(HotelSearchQueryDto, ['city', 'country', 'checkIn', 'checkOut'] as const) {
  @ApiPropertyOptional({ minimum: 1, description: 'Number of the city group (cityGroups in GET /itineraries/:id), from 1. Default 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  group?: number;

  @ApiPropertyOptional({ example: 'cairo', description: "A city_id of one of the itinerary's days: its first city group" })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'city must be a city_id such as cairo or new_york' })
  city?: string;

  @ApiPropertyOptional({ example: '2026-12-02', description: "YYYY-MM-DD, not before the group's first day. Default: the group's first day" })
  @IsOptional()
  @IsCalendarDate()
  checkIn?: string;

  @ApiPropertyOptional({ example: '2026-12-04', description: "YYYY-MM-DD, not after the day after the group's last day. Default: that day" })
  @IsOptional()
  @IsCalendarDate()
  checkOut?: string;
}

/**
 * ITN-26: the flight search (GET /flights/search) into a city group of the itinerary. The destination is the group's
 * city; the origin is `fromCity`, or the city of the previous group. Every other filter is the flight search's own.
 */
export class ItineraryFlightSearchQueryDto extends OmitType(FlightSearchQueryDto, ['origin', 'destination', 'departureDate', 'returnDate'] as const) {
  @ApiPropertyOptional({ minimum: 1, description: 'The city group to fly INTO (cityGroups in GET /itineraries/:id), from 1. Default 1' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  group?: number;

  @ApiPropertyOptional({ example: 'cairo', description: "A city_id of one of the itinerary's days: fly into its first city group" })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'city must be a city_id such as cairo or new_york' })
  city?: string;

  @ApiPropertyOptional({ example: 'london', description: 'A city_id to fly from. Default: the city of the previous group; required for the first group' })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'fromCity must be a city_id such as london or new_york' })
  fromCity?: string;

  @ApiPropertyOptional({ example: '2026-12-01', description: "Local departure date, YYYY-MM-DD: the group's first day or the day before. Default: the group's first day" })
  @IsOptional()
  @IsCalendarDate()
  date?: string;
}
