import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
} from '@nestjs/swagger';

import { PostStatus } from '../enums/post-status.enum';

export const BLOG_PAGE_SIZE = 10;

function trimTags(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map((tag: unknown) =>
        typeof tag === 'string' ? tag.trim() : tag,
      )
    : value;
}

// These DTOs describe the shared Blog contracts. BLG-01, BLG-05, and BLG-08
// endpoint ownership remains subject to team confirmation.
export class CreatePostDto {
  @ApiProperty({ example: 'A weekend in Alexandria' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'A short travel story about the coast.' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiProperty({ enum: PostStatus, example: PostStatus.DRAFT })
  @IsEnum(PostStatus)
  status: PostStatus;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 5,
    example: ['Alexandria', 'Egypt'],
  })
  @IsOptional()
  @Transform(({ value }) => trimTags(value))
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(30, { each: true })
  tags?: string[];
}

export class UpdatePostDto extends PartialType(CreatePostDto) {}

export class PostsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    example: 1,
    description: '1-based page number. Blog lists use a fixed page size of 10.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ maxLength: 30, example: 'Alexandria' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(30)
  tag?: string;
}

export class SearchPostsQueryDto extends PostsQueryDto {
  @ApiProperty({ example: 'coast', maxLength: 100 })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  keyword: string;
}

export class CreateCommentDto {
  @ApiProperty({ maxLength: 500, example: 'This looks like a great trip.' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  body: string;
}

export class UpdateCommentDto extends PartialType(CreateCommentDto) {}
