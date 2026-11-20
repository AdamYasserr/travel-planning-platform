import {
  IsOptional,
  IsString,
  IsNotEmpty,
  MaxLength,
  Matches,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateProfileDto {
  @ApiPropertyOptional({ description: 'Updated display name', example: 'Amina Hassan', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'Updated phone number', example: '+201001234567', nullable: true, maxLength: 30 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ description: 'Preferred three-letter currency code', example: 'USD', pattern: '^[A-Za-z]{3}$' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'Preferred currency must be a 3-letter currency code',
  })
  preferredCurrency?: string;
}
