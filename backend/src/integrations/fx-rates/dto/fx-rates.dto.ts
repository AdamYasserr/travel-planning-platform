import { Transform, Type } from 'class-transformer';
import {
  IsNumber,
  IsPositive,
  IsString,
  Matches,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

const CURRENCY_CODE = /^[A-Za-z]{3}$/;

export class FxRateQueryDto {
  @ApiProperty({ description: 'Three-letter source currency code', example: 'USD', pattern: '^[A-Za-z]{3}$' })
  @ApiProperty({ description: 'Three-letter target currency code', example: 'EGP', pattern: '^[A-Za-z]{3}$' })
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(CURRENCY_CODE)
  from: string;

  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(CURRENCY_CODE)
  to: string;
}

export class FxConvertQueryDto extends FxRateQueryDto {
  @ApiProperty({ description: 'Positive finite amount to convert', example: 100, type: Number, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount: number;
}
