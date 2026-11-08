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
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ description: 'Display name', example: 'Amina Hassan', maxLength: 100 })
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
  password: string;

  @ApiProperty({ description: 'Must be true to accept the Terms and Privacy Policy', example: true })
  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the Terms and Privacy Policy',
  })
  acceptTerms: boolean;
}