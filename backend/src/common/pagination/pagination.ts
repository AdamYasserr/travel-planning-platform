import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** GEN-05: every list defaults to 10 per page; `limit` may go up to 100. */
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

/** `page` (>= 1) and `limit` (1-100, default 10). Anything else is a 400 on that field. */
export class PageQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit: number = DEFAULT_PAGE_SIZE;
}

/** The `{ items, page, limit, total, pages }` page shape used by the newer lists. */
export function paged<T>(items: T[], total: number, page: number, limit: number) {
  return { items, page, limit, total, pages: Math.ceil(total / limit) };
}
