import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsEnum, IsInt, IsMongoId, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';

import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';
import { CabinClass } from '../schemas/cabin-inventory.schema';

export enum FlightSortBy {
  PRICE = 'price',
  DURATION = 'duration',
  DEPARTURE = 'departure',
}

export enum SortOrder {
  ASC = 'asc',
  DESC = 'desc',
}

export const FLIGHT_SEARCH_PAGE_SIZE = 10;
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** FLT-11/12/15: every parameter is validated; a bad value is a 400 on that field, never an empty result. */
export class FlightSearchQueryDto {
  @ApiProperty({ example: 'CAI', description: 'Departure airport IATA code (must be an imported airport)' })
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'origin must be a 3-letter IATA airport code' })
  origin: string;

  @ApiProperty({ example: 'DXB', description: 'Arrival airport IATA code (must be an imported airport)' })
  @Transform(upper)
  @Matches(/^[A-Z]{3}$/, { message: 'destination must be a 3-letter IATA airport code' })
  destination: string;

  @ApiProperty({ example: '2026-12-05', description: 'Departure date: the LOCAL date at the departure airport (YYYY-MM-DD)' })
  @IsCalendarDate()
  departureDate: string;

  @ApiPropertyOptional({ example: '2026-12-12', description: 'Round trip: LOCAL date at the arrival airport, not before departureDate' })
  @IsOptional()
  @IsCalendarDate()
  returnDate?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1, maximum: 9, description: 'Passengers aged 12+; each takes a seat' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(9)
  adults: number = 1;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 9, description: 'Passengers aged 2-11; each takes a seat' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  children: number = 0;

  @ApiPropertyOptional({ default: 0, minimum: 0, maximum: 9, description: 'Passengers under 2: no seat, 10% of the fare; at most one per adult' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(9)
  infants: number = 0;

  @ApiPropertyOptional({ enum: CabinClass })
  @IsOptional()
  @IsEnum(CabinClass)
  cabinClass?: CabinClass;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive minimum fare per seat (platform currency, as stored)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Inclusive maximum fare per seat (platform currency, as stored)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  maxPrice?: number;

  @ApiPropertyOptional({ description: 'Only flights of this airline' })
  @IsOptional()
  @IsMongoId()
  airlineId?: string;

  @ApiPropertyOptional({ enum: FlightSortBy, default: FlightSortBy.DEPARTURE, description: 'price = cheapest matching cabin' })
  @IsOptional()
  @IsEnum(FlightSortBy)
  sortBy: FlightSortBy = FlightSortBy.DEPARTURE;

  @ApiPropertyOptional({ enum: SortOrder, default: SortOrder.ASC })
  @IsOptional()
  @IsEnum(SortOrder)
  order: SortOrder = SortOrder.ASC;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: FLIGHT_SEARCH_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = FLIGHT_SEARCH_PAGE_SIZE;
}
