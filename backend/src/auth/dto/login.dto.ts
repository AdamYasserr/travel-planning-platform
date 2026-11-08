import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ description: 'Registered email address', example: 'amina@example.com' })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: 'Account password' })
  @IsString()
  @IsNotEmpty()
  password: string;
}