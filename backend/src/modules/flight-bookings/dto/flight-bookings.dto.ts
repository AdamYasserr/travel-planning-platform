import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

import { CabinClass } from '../../flights/schemas/cabin-inventory.schema';

// TODO(ASSUMPTION): The workbook gives no limit on passengers per booking.
// A cap of 9 keeps one request from holding a whole cabin.
export const MAX_PASSENGERS_PER_BOOKING = 9;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// FLT-19 / FLT-08: Extra bags for one passenger on one segment
export class PassengerBaggageDto {
  @ApiProperty({
    minimum: 0,
    example: 1,
    description:
      "Extra bags for this passenger on this segment (<= airline's maxExtraBagsPerPassenger; not allowed for infants)",
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  extraBags: number;

  @ApiPropertyOptional({
    type: [Number],
    example: [23],
    description:
      "Optional weight of each extra bag in kg. If given, one weight per extra bag, each <= the cabin's maxWeightPerBagKg",
  })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  @Min(0.01, { each: true })
  bagWeightsKg?: number[];
}

// FLT-19: Passenger details
export class FlightPassengerDto {
  @ApiProperty({ example: 'Ahmed Ibrahim' })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  // TODO(ASSUMPTION): Length limits are not in the workbook; 2-100 characters.
  @Length(2, 100)
  fullName: string;

  @ApiProperty({
    example: '1995-04-12',
    description:
      'YYYY-MM-DD, not in the future. The passenger type (Adult 12+, Child 2-11, Infant under 2) is derived from it at the outbound departure date',
  })
  @Matches(DATE_ONLY, { message: 'dateOfBirth must be in YYYY-MM-DD format' })
  @IsISO8601({ strict: true }, { message: 'dateOfBirth must be a valid date' })
  dateOfBirth: string;

  @ApiProperty({
    example: 'A12345678',
    description: 'Passport or national ID number (unique within the booking)',
  })
  @Transform(trimmed)
  @IsString()
  @IsNotEmpty()
  // TODO(ASSUMPTION): Format is not in the workbook; 3-30 letters, digits or hyphens.
  @Matches(/^[A-Za-z0-9-]{3,30}$/, {
    message:
      'documentNumber must be 3-30 characters of letters, digits or hyphens',
  })
  documentNumber: string;

  @ApiPropertyOptional({ type: PassengerBaggageDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerBaggageDto)
  outboundBaggage?: PassengerBaggageDto;

  @ApiPropertyOptional({
    type: PassengerBaggageDto,
    description: 'Only with returnFlightId',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PassengerBaggageDto)
  returnBaggage?: PassengerBaggageDto;
}

// FLT-19 / FLT-21 / FLT-22: Same body for the summary and the hold
export class CreateFlightBookingDto {
  @ApiProperty({ description: 'Outbound flight ID' })
  @IsMongoId()
  outboundFlightId: string;

  @ApiPropertyOptional({
    description:
      'FLT-12(a): Return flight ID for a round trip (reversed route, departing after the outbound arrives)',
  })
  @IsOptional()
  @IsMongoId()
  returnFlightId?: string;

  @ApiProperty({
    enum: CabinClass,
    description: 'One cabin class per booking, used for every segment',
  })
  @IsEnum(CabinClass)
  cabinClass: CabinClass;

  @ApiProperty({
    type: [FlightPassengerDto],
    description: `1-${MAX_PASSENGERS_PER_BOOKING} passengers; at least one adult, infants <= adults`,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PASSENGERS_PER_BOOKING)
  @ValidateNested({ each: true })
  @Type(() => FlightPassengerDto)
  passengers: FlightPassengerDto[];
}

// FLT-26: Preview first, then cancel with confirm = true
export class CancelFlightBookingDto {
  @ApiPropertyOptional({
    default: false,
    description:
      'false (default): only preview the refund. true: cancel the booking',
  })
  @IsOptional()
  // Accept only real true / "true"; with implicit conversion "false" would
  // otherwise become true.
  @Transform(({ obj }: { obj: Record<string, unknown> }) =>
    obj.confirm === undefined
      ? undefined
      : obj.confirm === true || obj.confirm === 'true'
        ? true
        : obj.confirm === false || obj.confirm === 'false'
          ? false
          : obj.confirm,
  )
  @IsBoolean()
  confirm?: boolean;
}

// FLT-29 / GEN-05
export class FlightBookingsPageQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1, description: '10 per page' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;
}
