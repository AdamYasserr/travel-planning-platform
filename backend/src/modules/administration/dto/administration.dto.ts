import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
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

export class AdminAccountQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @ApiPropertyOptional({ enum: ['user', 'moderator', 'admin'] })
  @IsOptional()
  @IsEnum(['user', 'moderator', 'admin'])
  role?: string;

  @ApiPropertyOptional({ description: 'Filter by account name or email' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AdminBookingQueryDto {
  @ApiPropertyOptional({ enum: ['flight', 'hotel'] })
  @IsOptional()
  @IsEnum(['flight', 'hotel'])
  type?: 'flight' | 'hotel';

  @ApiPropertyOptional({ example: 'Pending Payment' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  status?: string;

  @ApiPropertyOptional({ description: 'Filter by booking owner ObjectId' })
  @IsOptional()
  @IsMongoId()
  userId?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
