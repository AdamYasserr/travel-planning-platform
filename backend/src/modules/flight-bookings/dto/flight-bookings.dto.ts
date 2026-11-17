import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BOOKING_GROUPS, type BookingGroup } from '../../../common/booking/booking-groups';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

import { CabinClass } from '../../flights/schemas/cabin-inventory.schema';

export class FlightBookingPassengerDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  fullName: string;

  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth: string;
}

export class CreateFlightBookingDto {
  @IsMongoId()
  flightId: string;

  @IsEnum(CabinClass)
  cabinClass: CabinClass;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => FlightBookingPassengerDto)
  passengers: FlightBookingPassengerDto[];

  @ApiPropertyOptional({
    description:
      'Optional. When true the policies are accepted at booking time. Otherwise accept them afterwards with POST /bookings/:type/:id/accept-policies; payment is blocked until then.',
  })
  @IsOptional()
  @IsBoolean()
  policiesAccepted?: boolean;
}

export class FlightBookingListQueryDto {
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
