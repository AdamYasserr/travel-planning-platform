import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum ProviderType {
  HOTEL = 'hotel',
  AIRLINE = 'airline',
}

export class CreateModeratorDto {
  @ApiProperty({ description: 'Moderator display name', example: 'Omar Hassan', maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'Unique email address', example: 'mod@example.com', maxLength: 255 })
  @IsEmail()
  @MaxLength(255)
  email: string;

  @ApiProperty({ description: 'Temporary password containing at least one letter and number' })
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'Password must contain at least one letter and one number',
  })
  password: string;

  @ApiProperty({ enum: ProviderType, description: 'Type of provider this moderator manages' })
  @IsEnum(ProviderType)
  providerType: ProviderType;

  @ApiProperty({ description: 'ID of the hotel or airline this moderator manages' })
  @IsMongoId()
  providerId: string;
}