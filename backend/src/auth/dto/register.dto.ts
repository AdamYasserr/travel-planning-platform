import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsString,
  MinLength,
  Matches,
  MaxLength,
  Equals,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { BCRYPT_MAX_PASSWORD_BYTES, MaxBytes } from '../../common/validators/max-bytes.decorator';

export class RegisterDto {
  @ApiProperty({ description: 'Display name', example: 'Amina Hassan', maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Unique email address', example: 'amina@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: 'Password containing at least one letter and number' })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain at least one letter and one number',
  })
  @MaxBytes(BCRYPT_MAX_PASSWORD_BYTES)
  password: string;

  @ApiProperty({ description: 'Must be true to accept the Terms and Privacy Policy', example: true })
  // Keep the raw value: implicit conversion would turn the string "false" into true.
  @Transform(({ obj, key }) => obj[key])
  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the Terms and Privacy Policy',
  })
  acceptTerms: boolean;
}