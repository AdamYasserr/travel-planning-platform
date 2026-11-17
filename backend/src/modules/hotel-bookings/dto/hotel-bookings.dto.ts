import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
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
}

export class HotelBookingIdParamDto {
  @IsString()
  @IsMongoId()
  id: string;
}
