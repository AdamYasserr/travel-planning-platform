import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { NotificationType } from '../enums/notification-type.enum';

export class NotificationResourceDto {
  @ApiProperty({
    description: 'Feature-owned type of the resource that generated the event',
    example: 'booking',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of the related resource',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  id: string;
}

// Internal event DTO. It does not define message text or an event payload.
export class CreateNotificationDto {
  @ApiProperty({
    description: 'Recipient user MongoDB ObjectId supplied by the event producer',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  recipientId: string;

  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiPropertyOptional({ type: NotificationResourceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => NotificationResourceDto)
  resource?: NotificationResourceDto;
}
