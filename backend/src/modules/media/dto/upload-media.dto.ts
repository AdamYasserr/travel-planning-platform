import { IsEnum, IsMongoId, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum MediaTargetType {
  PROFILE = 'profile',
  POST = 'post',
  ITINERARY = 'itinerary',
  COMMENT = 'comment',
}

export class UploadMediaDto {
  @ApiProperty({ enum: MediaTargetType, description: 'Media target. Only profile uploads are currently supported.', example: MediaTargetType.PROFILE })
  @IsEnum(MediaTargetType)
  targetType: MediaTargetType;

  @ApiPropertyOptional({ description: 'Target MongoDB ObjectId; required by future non-profile integrations.', example: '507f1f77bcf86cd799439011' })
  @IsOptional()
  @IsMongoId()
  targetId?: string;
}
