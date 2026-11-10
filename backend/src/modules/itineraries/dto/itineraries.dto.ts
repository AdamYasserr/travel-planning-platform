import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  ApiProperty,
  ApiPropertyOptional,
  PartialType,
} from '@nestjs/swagger';
import { ItineraryVisibility } from '../enums/itinerary-visibility.enum';
import { BudgetCategory } from '../schemas/budget.schema';

export class CreateItineraryDto {
  @ApiProperty({ example: 'Summer in Italy' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({
    type: [String],
    description: 'MongoDB ObjectIds of predefined countries',
    example: ['507f1f77bcf86cd799439011'],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsMongoId({ each: true })
  countryIds: string[];

  @ApiProperty({
    description: 'Itinerary start date',
    example: '2026-12-01',
  })
  @IsDateString({ strict: true })
  startDate: string;
}

export class UpdateItineraryDto extends PartialType(CreateItineraryDto) {
  @ApiPropertyOptional({
    enum: Object.values(ItineraryVisibility),
    example: ItineraryVisibility.PUBLIC,
  })
  @IsOptional()
  @IsEnum(ItineraryVisibility)
  visibility?: ItineraryVisibility;
}

export class CreateItineraryDayDto {
  @ApiProperty({
    description: 'MongoDB ObjectId of a predefined city',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  cityId: string;

  @ApiPropertyOptional({ example: 'Visit the historic district.' })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  notes?: string;
}

export class UpdateItineraryDayDto extends PartialType(
  CreateItineraryDayDto,
) {}

export class CreateItineraryActivityDto {
  @ApiProperty({ example: 'Colosseum tour' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'Explore the ancient Roman amphitheater.' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ example: '10:30' })
  @IsOptional()
  @IsString()
  time?: string;

  @ApiPropertyOptional({ example: 35, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cost?: number;

  @ApiPropertyOptional({
    description: 'Three-letter currency code for the activity cost',
    example: 'EUR',
  })
  @ValidateIf((dto: CreateItineraryActivityDto) => dto.cost !== undefined)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  costCurrency?: string;
}

export class UpdateItineraryActivityDto extends PartialType(
  CreateItineraryActivityDto,
) {}

export class CreateBudgetEntryDto {
  @ApiProperty({
    enum: Object.values(BudgetCategory),
    example: BudgetCategory.FOOD,
  })
  @IsEnum(BudgetCategory)
  category: BudgetCategory;

  @ApiProperty({ example: 25, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({
    description: 'Three-letter currency code',
    example: 'EUR',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  currency: string;
}

export class UpdateBudgetEntryDto extends PartialType(
  CreateBudgetEntryDto,
) {}

export class CreateTransportCostDto {
  @ApiProperty({ example: 'Train' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  mode: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of the origin city',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  fromCityId: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of the destination city',
    example: '507f1f77bcf86cd799439012',
  })
  @IsMongoId()
  toCityId: string;

  @ApiProperty({ example: 42.5, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({
    description: 'Three-letter currency code',
    example: 'EUR',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  currency: string;

  @ApiProperty({
    description: 'MongoDB ObjectId of the itinerary day',
    example: '507f1f77bcf86cd799439013',
  })
  @IsMongoId()
  dayId: string;
}

export class UpdateTransportCostDto extends PartialType(
  CreateTransportCostDto,
) {}

export class ReorderItineraryDaysDto {
  @ApiProperty({
    description: 'MongoDB ObjectId of the day to move',
    example: '507f1f77bcf86cd799439011',
  })
  @IsMongoId()
  dayId: string;

  @ApiProperty({
    description: 'New day position, starting at 1',
    example: 2,
    minimum: 1,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  newPosition: number;
}