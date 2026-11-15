import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
} from 'class-validator';

import { CabinClass } from '../schemas/cabin-inventory.schema';

export const FLIGHT_SEARCH_SORT_FIELDS = [
  'price',
  'duration',
  'departureTime',
] as const;
export type FlightSearchSortField = (typeof FLIGHT_SEARCH_SORT_FIELDS)[number];

export const SORT_ORDERS = ['asc', 'desc'] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const IATA_CODE = /^[A-Z]{3}$/;

const toUpperTrimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

// FLT-11 / FLT-12 / FLT-15: Flight search query parameters
export class FlightSearchQueryDto {
  @ApiProperty({
    example: 'CAI',
    description: 'Departure airport IATA code (must exist in airports)',
  })
  @Transform(toUpperTrimmed)
  @IsString()
  @Matches(IATA_CODE, {
    message: 'departureAirport must be a 3-letter IATA code',
  })
  departureAirport: string;

  @ApiProperty({
    example: 'BER',
    description:
      'Arrival airport IATA code (must exist in airports and differ from departureAirport)',
  })
  @Transform(toUpperTrimmed)
  @IsString()
  @Matches(IATA_CODE, {
    message: 'arrivalAirport must be a 3-letter IATA code',
  })
  arrivalAirport: string;

  @ApiProperty({
    example: '2026-11-21',
    description: 'Local date at the departure airport (YYYY-MM-DD)',
  })
  @Matches(DATE_ONLY, { message: 'departureDate must be in YYYY-MM-DD format' })
  @IsISO8601(
    { strict: true },
    { message: 'departureDate must be a valid date' },
  )
  departureDate: string;

  @ApiPropertyOptional({
    example: '2026-11-28',
    description:
      'FLT-12: Round trip. Local date at the return departure airport (YYYY-MM-DD), not before departureDate',
  })
  @IsOptional()
  @Matches(DATE_ONLY, { message: 'returnDate must be in YYYY-MM-DD format' })
  @IsISO8601({ strict: true }, { message: 'returnDate must be a valid date' })
  returnDate?: string;

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description: 'FLT-12: Adults (12+). At least one adult is required',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1, { message: 'At least one adult is required' })
  adults: number = 1;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    description: 'FLT-12: Children (2-11). Pay the cabin fare and take a seat',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  children: number = 0;

  @ApiPropertyOptional({
    default: 0,
    minimum: 0,
    description:
      'FLT-12: Infants (under 2). Pay 10% of the fare, take no seat, and cannot exceed adults',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  infants: number = 0;

  @ApiPropertyOptional({
    enum: CabinClass,
    description: 'FLT-12: Only return this cabin class',
  })
  @IsOptional()
  @IsEnum(CabinClass)
  cabinClass?: CabinClass;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'FLT-15: Minimum cabin price (inclusive)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'FLT-15: Maximum cabin price (inclusive)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({
    enum: FLIGHT_SEARCH_SORT_FIELDS,
    default: 'departureTime',
    description:
      'FLT-15: Sort field. price uses the cheapest matching cabin',
  })
  @IsOptional()
  @IsIn(FLIGHT_SEARCH_SORT_FIELDS)
  sortBy: FlightSearchSortField = 'departureTime';

  @ApiPropertyOptional({ enum: SORT_ORDERS, default: 'asc' })
  @IsOptional()
  @IsIn(SORT_ORDERS)
  order: SortOrder = 'asc';

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description: 'GEN-05: Page of the outbound list (10 per page)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  outboundPage: number = 1;

  @ApiPropertyOptional({
    default: 1,
    minimum: 1,
    description:
      'GEN-05: Page of the return list (10 per page). Used only with returnDate',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  returnPage: number = 1;
}
