
import {
  IsNumber,
  IsString,
  IsNotEmpty,
  IsInt,
  Min,
  Length,
} from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  @Length(3, 3)
  currency: string;
}
