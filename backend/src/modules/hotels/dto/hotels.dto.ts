import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
  ArrayMinSize,
  IsDateString,
  IsPositive,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
    ValidationArguments,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
  PickType
} from '@nestjs/swagger';

export class HotelCancellationTierDto {
  @ApiProperty({
    description: 'Minimum whole number of days before check-in for this tier',
    example: 7,
    minimum: 0,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  daysBeforeCheckIn: number;

  @ApiProperty({
    description: 'Refund percentage for this cancellation tier',
    example: 50,
    minimum: 0,
    maximum: 100,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  refundPercentage: number;
}

export class CreateHotelDto {
  @ApiProperty({ example: 'Nile View Hotel' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '12 Corniche Road, Cairo' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  address: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of a seeded city',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  cityId: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of a seeded country',
    example: '507f1f77bcf86cd799439012',
  })
  @IsMongoId()
  countryId: string;

  @ApiPropertyOptional({ example: 'A hotel overlooking the Nile.' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['https://example.com/hotel-front.jpg'],
    maxItems: 5,
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  photos?: string[];

  @ApiProperty({ example: 5, minimum: 1, maximum: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  starClass: number;

  @ApiPropertyOptional({ type: [String], example: ['Pool', 'Wi-Fi'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  amenities?: string[];

  @ApiProperty({
    description: 'Local hotel check-in time in 24-hour HH:mm format',
    example: '15:00',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  checkInTime: string;

  @ApiProperty({
    description: 'Local hotel check-out time in 24-hour HH:mm format',
    example: '11:00',
  })
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  checkOutTime: string;

  @ApiPropertyOptional({
    type: [HotelCancellationTierDto],
    example: [
      { daysBeforeCheckIn: 14, refundPercentage: 100 },
      { daysBeforeCheckIn: 3, refundPercentage: 50 },
      { daysBeforeCheckIn: 0, refundPercentage: 0 },
    ],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HotelCancellationTierDto)
  @ArrayUnique(
    (tier: HotelCancellationTierDto) => tier.daysBeforeCheckIn,
    { message: 'Cancellation tier day thresholds must be unique' },
  )
  cancellationTiers?: HotelCancellationTierDto[];
}

export class UpdateHotelDto extends PartialType(CreateHotelDto) {}

export class RoomDateRangeDto {
  @ApiProperty({
    description: 'First bookable date, inclusive, in YYYY-MM-DD format',
    example: '2026-12-01',
  })
  @IsDateString({ strict: true })
  startDate: string;

  @ApiProperty({
    description: 'End date, exclusive, in YYYY-MM-DD format',
    example: '2026-12-10',
  })
  @IsDateString({ strict: true })
  endDate: string;
}

@ValidatorConstraint({ name: 'dateRangesDoNotOverlap', async: false })
class DateRangesDoNotOverlapConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown): boolean {
    if (!Array.isArray(value)) {
      return true;
    }

    const ranges = value as RoomDateRangeDto[];
    const parsedRanges = ranges.map((range) => ({
      start: Date.parse(range?.startDate ?? ''),
      end: Date.parse(range?.endDate ?? ''),
    }));

    if (
      parsedRanges.some(
        (range) =>
          !Number.isFinite(range.start) ||
          !Number.isFinite(range.end) ||
          range.end <= range.start,
      )
    ) {
      return false;
    }

    parsedRanges.sort((a, b) => a.start - b.start);

    return parsedRanges.every(
      (range, index) =>
        index === 0 || parsedRanges[index - 1].end <= range.start,
    );
  }

  defaultMessage(): string {
    return 'Bookable date ranges must be valid and must not overlap';
  }
}

export class CreateRoomDto {
  @ApiProperty({ example: 'Deluxe 402' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Deluxe double' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  type: string;

  @ApiProperty({ example: 2, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beds: number;

  @ApiProperty({ example: 3, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxOccupancy: number;

  @ApiProperty({ example: 125.5, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  pricePerNight: number;

  @ApiProperty({
    description: 'ISO 4217 currency code used for this room rate',
    example: 'EGP',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ApiPropertyOptional({
    type: [RoomDateRangeDto],
    example: [{ startDate: '2026-12-01', endDate: '2026-12-10' }],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RoomDateRangeDto)
  @Validate(DateRangesDoNotOverlapConstraint)
  availabilityRanges?: RoomDateRangeDto[];
}

export class SetRoomAvailabilityDto {
  @ApiProperty({
    type: [RoomDateRangeDto],
    example: [{ startDate: '2026-12-01', endDate: '2026-12-10' }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RoomDateRangeDto)
  @Validate(DateRangesDoNotOverlapConstraint)
  availabilityRanges: RoomDateRangeDto[];
}

  export class UpdateRoomDto extends PartialType(
  PickType(
    CreateRoomDto,
    ['beds', 'maxOccupancy', 'pricePerNight', 'currency'] as const,
  ),
) {}

export class PaginationQueryDto {
  @ApiPropertyOptional({
    example: 1,
    minimum: 1,
    default: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;
}

export class BlockRoomDto {
  @ApiProperty({
    type: [RoomDateRangeDto],
    example: [{ startDate: '2026-12-01', endDate: '2026-12-04' }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RoomDateRangeDto)
  @Validate(DateRangesDoNotOverlapConstraint)
  blockedRanges: RoomDateRangeDto[];
}

@ValidatorConstraint({ name: 'roomStatusEndAfterStart', async: false })
class RoomStatusEndAfterStartConstraint
  implements ValidatorConstraintInterface
{
  validate(endDate: unknown, args: ValidationArguments): boolean {
    const startDate = (args.object as { startDate?: string }).startDate;

    if (typeof startDate !== 'string' || typeof endDate !== 'string') {
      return false;
    }

    return Date.parse(endDate) > Date.parse(startDate);
  }

  defaultMessage(): string {
    return 'endDate must be after startDate';
  }
}

export class RoomStatusQueryDto {
  @ApiProperty({
    description: 'First date to check, inclusive, in YYYY-MM-DD format',
    example: '2026-12-01',
  })
  @IsDateString({ strict: true })
  startDate: string;

  @ApiProperty({
    description: 'Last date to check, exclusive, in YYYY-MM-DD format',
    example: '2026-12-05',
  })
  @IsDateString({ strict: true })
  @Validate(RoomStatusEndAfterStartConstraint)
  endDate: string;
}

@ValidatorConstraint({ name: 'hotelDetailsDatePair', async: false })
class HotelDetailsDatePairConstraint
  implements ValidatorConstraintInterface
{
  validate(_value: unknown, args: ValidationArguments): boolean {
    const query = args.object as {
      checkInDate?: string;
      checkOutDate?: string;
    };

    const hasCheckIn = Boolean(query.checkInDate);
    const hasCheckOut = Boolean(query.checkOutDate);

    if (hasCheckIn !== hasCheckOut) {
      return false;
    }

    if (!hasCheckIn && !hasCheckOut) {
      return true;
    }

    return Date.parse(query.checkOutDate!) > Date.parse(query.checkInDate!);
  }

  defaultMessage(): string {
    return 'Provide both checkInDate and checkOutDate, with checkOutDate after checkInDate';
  }
}

export class HotelDetailsQueryDto {
  @ApiPropertyOptional({
    description: 'Check-in date in YYYY-MM-DD format',
    example: '2026-12-01',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Validate(HotelDetailsDatePairConstraint)
  checkInDate?: string;

  @ApiPropertyOptional({
    description: 'Check-out date in YYYY-MM-DD format',
    example: '2026-12-05',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Validate(HotelDetailsDatePairConstraint)
  checkOutDate?: string;
}
