
import {
  IsNumber,
  IsString,
  IsOptional,
  IsArray,
  IsInt,
  Min,
  Max,
  ValidateNested,
  ArrayUnique,
} from 'class-validator';

import { Type } from 'class-transformer';

// FLT-09: Define a cancellation refund tier
export class CancellationTierDto {
  @IsInt()
  @Min(0)
  daysBeforeDeparture: number;

  @IsNumber()
  @Min(0)
  @Max(100)
  refundPercentage: number;
}

// FLT-09: Create or update cancellation policy
export class UpdateCancellationPolicyDto {
  @IsArray()
  @ArrayUnique(
    (tier: CancellationTierDto) =>
      tier.daysBeforeDeparture,
  )
  @ValidateNested({ each: true })
  @Type(() => CancellationTierDto)
  tiers: CancellationTierDto[];

  @IsOptional()
  @IsString()
  description?: string;
}
