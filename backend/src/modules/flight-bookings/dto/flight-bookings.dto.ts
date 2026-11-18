import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BOOKING_GROUPS, type BookingGroup } from '../../../common/booking/booking-groups';
import { IsCalendarDate } from '../../../common/validators/calendar-date.decorator';
import {
  ArrayMaxSize,
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

  @ApiPropertyOptional({ description: 'FLT-19: 6-9 letters or digits. Send this OR nationalId, not both.', example: 'A1234567' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{6,9}$/, { message: 'passportNumber must be 6 to 9 letters or digits' })
  passportNumber?: string;

  @ApiPropertyOptional({ description: 'Required with passportNumber: YYYY-MM-DD, after the arrival of the last flight.', example: '2031-01-31' })
  @IsOptional()
  @IsCalendarDate()
  passportExpiry?: string;

  @ApiPropertyOptional({ description: 'FLT-19: national ID number (4-20 letters, digits or "-"). Send this OR passportNumber, not both.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{4,20}$/, { message: 'nationalId must be 4 to 20 letters, digits or "-"' })
  nationalId?: string;

  @ApiProperty({ description: 'Country code from GET /countries (e.g. EG).', example: 'EG' })
  @IsString()
  @Matches(/^[A-Za-z]{2,3}$/, { message: 'nationality must be a country code from the Countries list' })
  nationality: string;
}

export class CreateFlightBookingDto {
  @IsMongoId()
  flightId: string;

  @IsEnum(CabinClass)
  cabinClass: CabinClass;

  @ApiProperty({
    description:
      'FLT-19: at least one adult; at most 9 adults and children; no more infants than adults. The passenger type ' +
      '(adult 12+, child 2-11, infant under 2) is derived from dateOfBirth on the departure day; do not send it.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(18)
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
