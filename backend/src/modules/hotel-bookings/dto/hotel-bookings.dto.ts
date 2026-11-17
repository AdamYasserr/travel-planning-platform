import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BOOKING_GROUPS, type BookingGroup } from '../../../common/booking/booking-groups';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export class HotelBookingRoomRequestDto {
  @IsMongoId()
  roomId: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  adults: number;

  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childrenAges: number[] = [];
}

export class CreateHotelBookingDto {
  @IsMongoId()
  hotelId: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkInDate: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  checkOutDate: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => HotelBookingRoomRequestDto)
  rooms: HotelBookingRoomRequestDto[];

  @ApiPropertyOptional({
    description:
      'Optional. When true the policies are accepted at booking time. Otherwise accept them afterwards with POST /bookings/:type/:id/accept-policies; payment is blocked until then.',
  })
  @IsOptional()
  @IsBoolean()
  policiesAccepted?: boolean;
}

export class HotelBookingListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 10; // GEN-05

  @ApiPropertyOptional({ enum: BOOKING_GROUPS, description: 'upcoming, past or cancelled (FLT-25 / HTL-20). Omit for all bookings.' })
  @IsOptional()
  @IsIn(BOOKING_GROUPS)
  group?: BookingGroup;
}

export class HotelBookingIdParamDto {
  @IsString()
  @IsMongoId()
  id: string;
}
