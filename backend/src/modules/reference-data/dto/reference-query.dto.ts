import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

/** GEN-05: page size 10 everywhere. */
export const REFERENCE_PAGE_SIZE = 10;
/** Dataset identifiers such as `cairo` or `new_york`. Format only: a well-formed unknown id just matches nothing. */
export const DATASET_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
export const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;

/** Malformed values (non-numeric page, bad limit, wrong-format id) are 400 on that field. */
export class ReferenceQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: REFERENCE_PAGE_SIZE }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = REFERENCE_PAGE_SIZE;
  @ApiPropertyOptional({ description: 'Filter by name' }) @IsOptional() @IsString() @MaxLength(100) search?: string;
}

export class CityQueryDto extends ReferenceQueryDto {
  @ApiPropertyOptional({ description: 'Country code, e.g. EG (2 letters)' })
  @IsOptional() @Matches(COUNTRY_CODE_PATTERN, { message: 'parentId must be a 2-letter country code' }) parentId?: string;
}

export class AttractionQueryDto extends ReferenceQueryDto {
  @ApiPropertyOptional({ description: 'city_id, e.g. cairo or new_york' })
  @IsOptional() @Matches(DATASET_ID_PATTERN, { message: 'parentId must be a city_id such as cairo or new_york' }) parentId?: string;
}
