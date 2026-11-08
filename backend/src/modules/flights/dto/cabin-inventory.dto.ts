
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsString,
  IsNotEmpty,
  IsOptional,
  Min,
  Length,
} from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string;

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

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
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
