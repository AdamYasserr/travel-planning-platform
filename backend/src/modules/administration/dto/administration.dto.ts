import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  Matches,
} from 'class-validator';
import { Type } from 'class-transformer';
import { HotelBookingStatus } from '../../hotel-bookings/schemas/hotel-booking.schema';

export enum ModeratorProviderType {
  AIRLINE = 'airline',
  HOTEL = 'hotel',
}

export enum AdminProviderType {
  AIRLINE = 'airline',
  HOTEL = 'hotel',
}

export class CreateModeratorDto {
  @ApiProperty({ example: 'Mona Hassan', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @ApiProperty({ example: 'mona@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ example: 'Airline', enum: ModeratorProviderType })
  @IsEnum(ModeratorProviderType)
  providerType: ModeratorProviderType;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsMongoId()
  providerId: string;
}

export enum AdminAccountStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DEACTIVATED = 'deactivated',
}

/** GEN-05: platform-wide page size is 10. */
export const ADMIN_PAGE_SIZE = 10;

export class AdminAccountQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: ADMIN_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = ADMIN_PAGE_SIZE;

  @ApiPropertyOptional({ enum: ['user', 'moderator', 'admin'], description: 'Filter by role (combines with status and search)' })
  @IsOptional()
  @IsEnum(['user', 'moderator', 'admin'])
  role?: string;

  @ApiPropertyOptional({ enum: AdminAccountStatus, description: 'Filter by status (combines with role and search)' })
  @IsOptional()
  @IsEnum(AdminAccountStatus)
  status?: AdminAccountStatus;

  @ApiPropertyOptional({ description: 'Case-insensitive match on name or email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export enum AdminBookingDateField {
  TRAVEL = 'travel',
  BOOKED = 'booked',
}

/** Hotel and flight bookings share one lifecycle (GEN-11); the enums have identical values. */
const BOOKING_STATUSES: string[] = Object.values(HotelBookingStatus);

export class AdminBookingQueryDto {
  @ApiPropertyOptional({ enum: ['flight', 'hotel'] })
  @IsOptional()
  @IsIn(['flight', 'hotel'])
  type?: 'flight' | 'hotel';

  @ApiPropertyOptional({ example: 'Pending Payment', enum: BOOKING_STATUSES })
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by booking owner ObjectId' })
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @ApiPropertyOptional({ example: '2026-12-01', description: 'Start of date range, inclusive (YYYY-MM-DD). Applies to the field chosen by dateField.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date in YYYY-MM-DD format' })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31', description: 'End of date range, inclusive (YYYY-MM-DD). Applies to the field chosen by dateField.' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date in YYYY-MM-DD format' })
  to?: string;

  @ApiPropertyOptional({
    enum: AdminBookingDateField,
    default: AdminBookingDateField.TRAVEL,
    description: 'Which date from/to filter: "travel" = check-in (hotel) or departure (flight) date; "booked" = booking creation date.',
  })
  @IsOptional()
  @IsEnum(AdminBookingDateField)
  dateField?: AdminBookingDateField = AdminBookingDateField.TRAVEL;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: ADMIN_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = ADMIN_PAGE_SIZE;
}
