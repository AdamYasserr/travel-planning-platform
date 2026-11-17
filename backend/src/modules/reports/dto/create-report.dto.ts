import { Transform } from 'class-transformer';
import { IsEnum, IsMongoId, IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export enum ReportTargetType {
  POST = 'post',
  COMMENT = 'comment',
  REVIEW = 'review',
  ITINERARY = 'itinerary',
}

export class CreateReportDto {
  @ApiProperty({
    enum: ReportTargetType,
    description: 'Type of content being reported',
    example: ReportTargetType.POST,
  })
  @IsEnum(ReportTargetType)
  targetType: ReportTargetType;

  @ApiProperty({
    description: 'MongoDB ObjectId of the reported content',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  targetId: string;

  @ApiProperty({
    description: 'Reason for the report',
    example: 'This post contains abusive content.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  reason: string;
}

export class ModerateReportDto {
  @ApiProperty({ enum: ['dismiss', 'hide', 'delete'] })
  @IsIn(['dismiss', 'hide', 'delete'])
  action: 'dismiss' | 'hide' | 'delete';

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class AdminReportQueryDto {
  @ApiPropertyOptional({ enum: ['open', 'resolved'] })
  @IsOptional()
  @IsIn(['open', 'resolved'])
  status?: 'open' | 'resolved';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
