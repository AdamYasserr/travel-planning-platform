import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Read the raw JSON value: implicit conversion would turn the string "5" into 5.
const raw = (key: 'rating' | 'comment') => ({ obj }: { obj: Record<string, unknown> }) => obj[key];
const trimmed = ({ obj }: { obj: Record<string, unknown> }) => (typeof obj.comment === 'string' ? obj.comment.trim() : obj.comment);

/** HTL-23: a review of a Completed stay. */
export class CreateReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5, description: 'A whole number from 1 to 5' })
  @Transform(raw('rating'))
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ maxLength: 1000, example: 'Lovely stay, friendly staff.' })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}

export class UpdateReviewDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Transform(raw('rating'))
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(1000)
  comment?: string;
}
