import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsString,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum ReportTargetType {
  POST = 'post',
  COMMENT = 'comment',
  REVIEW = 'review',
  ITINERARY = 'itinerary',
}

export class CreateReportDto {
  @ApiProperty({ enum: ReportTargetType, description: 'Type of content being reported', example: ReportTargetType.POST })
  @IsEnum(ReportTargetType)
  targetType: ReportTargetType;

  @ApiProperty({ description: 'MongoDB ObjectId of the reported content', example: '507f1f77bcf86cd799439011' })
  @IsMongoId()
  targetId: string;

  @ApiProperty({ description: 'Reason for the report', example: 'This post contains abusive content.' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  reason: string;
}
