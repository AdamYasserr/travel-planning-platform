import { IsEnum, IsMongoId, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum MediaTargetType {
  PROFILE = 'profile',
  POST = 'post',
  ITINERARY = 'itinerary',
  ACTIVITY = 'activity',
  COMMENT = 'comment',
}

export class UploadMediaDto {
  @ApiProperty({
    enum: MediaTargetType,
    description: 'Target type for the uploaded media',
    example: MediaTargetType.PROFILE,
  })
  @IsEnum(MediaTargetType)
  targetType: MediaTargetType;

  @ApiPropertyOptional({
    description: 'Activity MongoDB ObjectId; required for activity images',
    example: '507f1f77bcf86cd799439011',
  })
  @ValidateIf((dto: UploadMediaDto) =>
    dto.targetType === MediaTargetType.ACTIVITY,
  )
  @IsMongoId()
  targetId?: string;
}