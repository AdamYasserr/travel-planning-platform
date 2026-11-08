import { IsBoolean, Equals } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class DeactivateAccountDto {
  @ApiProperty({ description: 'Must be true to confirm deactivation', example: true })
  @IsBoolean()
  @Equals(true, {
    message: 'You must confirm account deactivation',
  })
  confirm: boolean;
}
