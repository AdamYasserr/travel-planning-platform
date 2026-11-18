
import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum MediaTargetType {
  PROFILE = 'profile',
  HOTEL = 'hotel',
  AIRLINE = 'airline',
  POST = 'post',
  ITINERARY = 'itinerary',
  /** ITN-12: an image of an itinerary activity (targetId is the activity id). */
  ACTIVITY = 'activity',
  COMMENT = 'comment',
}

export class UploadMediaDto {
  @ApiProperty({
    enum: MediaTargetType,
    description: 'Media target type.',
    example: MediaTargetType.HOTEL,
  })
  @IsEnum(MediaTargetType)
  targetType: MediaTargetType;

  @ApiPropertyOptional({
    description: 'Target MongoDB ObjectId; required for hotel and airline uploads.',
    example: '507f1f77bcf86cd799439011',
  })
  @IsOptional()
  @IsMongoId()
  targetId?: string;
}
