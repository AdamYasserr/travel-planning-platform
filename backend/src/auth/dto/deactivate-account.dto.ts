import { IsBoolean, Equals } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class DeactivateAccountDto {
  @ApiProperty({ description: 'Must be true to confirm deactivation', example: true })
  // Keep the raw value: implicit conversion would turn the string "false" into true.
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  @Equals(true, {
    message: 'You must confirm account deactivation',
  })
  confirm: boolean;
}
