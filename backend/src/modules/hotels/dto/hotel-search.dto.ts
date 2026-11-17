import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';
import { COUNTRY_CODE_PATTERN, DATASET_ID_PATTERN } from '../../reference-data/dto/reference-query.dto';

export enum HotelSortBy {
  PRICE = 'price',
  RATING = 'rating',
}

export enum HotelSortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export const HOTEL_SEARCH_PAGE_SIZE = 10;
const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trimUpper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** HTL-15 and HTL-11: the stay. Check-out must be after check-in and check-in cannot be in the past (UTC date). */
export class RoomsAvailableQueryDto {
  @ApiProperty({ example: '2026-12-01', description: 'Check-in date, YYYY-MM-DD (UTC date; not in the past)' })
  @IsCalendarDate()
  checkIn: string;

  @ApiProperty({ example: '2026-12-05', description: 'Check-out date, YYYY-MM-DD; must be after checkIn' })
  @IsCalendarDate()
  checkOut: string;
}

/** HTL-11/12: every parameter is validated; a bad value is a 400 on that field, never an empty 200. */
export class HotelSearchQueryDto extends RoomsAvailableQueryDto {
  @ApiPropertyOptional({ example: 'cairo', description: 'A city_id from GET /cities. Give exactly one of city or country' })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'city must be a city_id such as cairo or new_york' })
  city?: string;

  @ApiPropertyOptional({ example: 'EG', description: 'A country code from GET /countries. Give exactly one of city or country' })
  @IsOptional()
  @Transform(trimUpper)
  @Matches(COUNTRY_CODE_PATTERN, { message: 'country must be a 2-letter country code' })
  country?: string;

  @ApiProperty({ minimum: 1, example: 2, description: 'Total guests; the best `rooms` free rooms must hold them together' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  guests: number;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  rooms: number = 1;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive minimum price per night of the cheapest free room' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive maximum price per night of the cheapest free room' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 5, description: 'Minimum average rating; unrated hotels are excluded when set' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(1)
  @Max(5)
  minRating?: number;

  @ApiPropertyOptional({ enum: HotelSortBy, default: HotelSortBy.PRICE })
  @IsOptional()
  @IsEnum(HotelSortBy)
  sortBy: HotelSortBy = HotelSortBy.PRICE;

  @ApiPropertyOptional({ enum: HotelSortOrder, description: 'Default: asc for price, desc for rating. Unrated hotels sort last either way' })
  @IsOptional()
  @IsEnum(HotelSortOrder)
  order?: HotelSortOrder;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: HOTEL_SEARCH_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = HOTEL_SEARCH_PAGE_SIZE;
}
