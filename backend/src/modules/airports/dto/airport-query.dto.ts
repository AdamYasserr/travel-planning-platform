import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { COUNTRY_CODE_PATTERN, DATASET_ID_PATTERN, REFERENCE_PAGE_SIZE } from '../../reference-data/dto/reference-query.dto';
export class AirportQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: REFERENCE_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = REFERENCE_PAGE_SIZE;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) search?: string;
  @ApiPropertyOptional({ description: 'Country code, e.g. EG' }) @IsOptional() @Matches(COUNTRY_CODE_PATTERN, { message: 'countryCode must be a 2-letter country code' }) countryCode?: string;
  @ApiPropertyOptional({ description: 'city_id, e.g. cairo' }) @IsOptional() @Matches(DATASET_ID_PATTERN, { message: 'cityId must be a city_id such as cairo or new_york' }) cityId?: string;
}
