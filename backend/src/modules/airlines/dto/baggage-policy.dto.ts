
import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Length,
  IsOptional,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBaggagePolicyDto {
  @IsNumber()
  @Min(0)
  carryOnAllowanceKg: number;

  @IsNumber()
  @Min(0)
  checkedBaggageAllowanceKg: number;

  // FLT-08: Price for each extra bag
  @IsNumber()
  @Min(0.01)
  pricePerExtraBag: number;

  // FLT-08: Maximum extra bags per passenger
  @IsInt()
  @Min(0)
  maxExtraBagsPerPassenger: number;

  @ApiPropertyOptional({ description: 'Omit to use the platform currency (PLATFORM_CURRENCY). Any other value is rejected with 400 "currency must be <platform currency>".', example: 'USD' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency?: string;
}
