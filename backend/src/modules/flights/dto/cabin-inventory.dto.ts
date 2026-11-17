
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  IsOptional,
  Min,
} from 'class-validator';

import { ApiPropertyOptional } from '@nestjs/swagger';

import { CabinClass } from '../schemas/cabin-inventory.schema';

export class CreateCabinInventoryDto {
  @IsEnum(CabinClass)
  cabinClass: CabinClass;

  @IsInt()
  @Min(1)
  totalSeats: number;

  @IsNumber()
  @Min(0.01)
  price: number;

  @ApiPropertyOptional({ description: 'Omit to use the platform currency (PLATFORM_CURRENCY). Any other value is rejected.', example: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  // FLT-04: Included free bags
  @IsInt()
  @Min(0)
  freeBagsCount: number;

  // FLT-04: Maximum weight for each bag
  @IsNumber()
  @Min(0.01)
  maxWeightPerBagKg: number;
}

export class UpdateCabinInventoryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  totalSeats?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  price?: number;

  @ApiPropertyOptional({ description: 'Must equal the platform currency (PLATFORM_CURRENCY).', example: 'USD' })
  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  freeBagsCount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  maxWeightPerBagKg?: number;
}
