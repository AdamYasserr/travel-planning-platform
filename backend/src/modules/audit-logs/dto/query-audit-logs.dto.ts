import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class QueryAuditLogsDto {
  @ApiPropertyOptional({ description: 'Filter by action, e.g. ACCOUNT_SUSPENDED' })
  @IsOptional()
  @IsString()
  action?: string;

  @ApiPropertyOptional({ description: 'Filter by the admin who did the action' })
  @IsOptional()
  @IsMongoId()
  actorId?: string;

  @ApiPropertyOptional({ description: 'Filter by target type, e.g. user, hotel, airline' })
  @IsOptional()
  @IsString()
  targetType?: string;

  @ApiPropertyOptional({ description: 'Only entries on or after this date (ISO)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'Only entries on or before this date (ISO)' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}