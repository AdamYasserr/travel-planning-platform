import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, Matches } from 'class-validator';

import { PageQueryDto } from '../../../common/pagination/pagination';
import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';
import { COUNTRY_CODE_PATTERN, DATASET_ID_PATTERN } from '../../reference-data/dto/reference-query.dto';

const trimLower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
const trimUpper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);

/** ITN-20: every filter is optional and validated; a bad value is a 400 on that field. */
export class PublicItinerarySearchQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ example: 'cairo', description: 'A city_id from GET /cities: itineraries with a day in this city' })
  @IsOptional()
  @Transform(trimLower)
  @Matches(DATASET_ID_PATTERN, { message: 'city must be a city_id such as cairo or new_york' })
  city?: string;

  @ApiPropertyOptional({ example: 'EG', description: 'A country code from GET /countries: itineraries that include this country' })
  @IsOptional()
  @Transform(trimUpper)
  @Matches(COUNTRY_CODE_PATTERN, { message: 'country must be a 2-letter country code' })
  country?: string;

  @ApiPropertyOptional({ example: '2026-12-01', description: 'YYYY-MM-DD: itineraries that are still running on or after this day' })
  @IsOptional()
  @IsCalendarDate()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'YYYY-MM-DD: itineraries that start on or before this day' })
  @IsOptional()
  @IsCalendarDate()
  to?: string;
}
