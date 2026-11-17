import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  Min,
  Matches,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { BudgetCategory } from "../schemas/budget.schema";
import { ItineraryVisibility } from "../enums/itinerary-visibility.enum";

export class CreateItineraryDto {
  @ApiProperty({ example: "Summer in Italy" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({
    type: [String],
    description: "MongoDB ObjectIds of predefined countries",
    example: ["507f1f77bcf86cd799439011"],
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsMongoId({ each: true })
  countryIds: string[];

  @ApiProperty({
    description: "Itinerary start date",
    example: "2026-12-01",
  })
  @IsDateString({ strict: true })
  startDate: string;

  @ApiPropertyOptional({ example: "2026-12-12" })
  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;

  @ApiPropertyOptional({
    enum: ItineraryVisibility,
    default: ItineraryVisibility.PRIVATE,
  })
  @IsOptional()
  @IsEnum(ItineraryVisibility)
  visibility?: ItineraryVisibility;

  @ApiPropertyOptional({
    example: "EGP",
    description: "Currency for converted summary totals",
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  displayCurrency?: string;
}

export class UpdateItineraryDto extends PartialType(CreateItineraryDto) {}

export class CreateItineraryDayDto {
  @ApiProperty({
    description: "MongoDB ObjectId of a predefined city",
    example: "507f1f77bcf86cd799439011",
  })
  @IsMongoId()
  cityId: string;

  @ApiPropertyOptional({ example: "Visit the historic district." })
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  notes?: string;
}

export class UpdateItineraryDayDto extends PartialType(CreateItineraryDayDto) {}

export class CreateItineraryActivityDto {
  @ApiProperty({ example: "Colosseum tour" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: "Explore the ancient Roman amphitheater." })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiPropertyOptional({ example: "10:30" })
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  time?: string;

  @ApiPropertyOptional({ example: 35, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  cost?: number;
}

export class UpdateItineraryActivityDto extends PartialType(
  CreateItineraryActivityDto,
) {}

export class CreateBudgetEntryDto {
  @ApiProperty({ example: "Museum tickets" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  description: string;

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
    description: "Three-letter currency code",
    example: "EUR",
  })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ApiPropertyOptional({ enum: ["planned", "actual"], default: "planned" })
  @IsOptional()
  @IsEnum(["planned", "actual"])
  type?: "planned" | "actual";

  @ApiPropertyOptional({ example: "2026-12-02T12:00:00.000Z" })
  @IsOptional()
  @IsDateString()
  incurredAt?: string;
}

export class UpdateBudgetEntryDto extends PartialType(CreateBudgetEntryDto) {}

export class CreateTransportCostDto {
  @ApiProperty({ example: "Train" })
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  mode: string;

  @ApiProperty({
    description: "MongoDB ObjectId of the origin city",
    example: "507f1f77bcf86cd799439011",
  })
  @IsMongoId()
  fromCityId: string;

  @ApiProperty({
    description: "MongoDB ObjectId of the destination city",
    example: "507f1f77bcf86cd799439012",
  })
  @IsMongoId()
  toCityId: string;

  @ApiProperty({ example: 42.5, minimum: 0 })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  amount: number;

  @ApiProperty({
    description: "Three-letter currency code",
    example: "EUR",
  })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(3, 3)
  @Matches(/^[A-Z]{3}$/)
  currency: string;

  @ApiProperty({
    description: "MongoDB ObjectId of the itinerary day",
    example: "507f1f77bcf86cd799439013",
  })
  @IsMongoId()
  dayId: string;
}

export class UpdateTransportCostDto extends PartialType(
  CreateTransportCostDto,
) {}

export class LinkBookingsDto {
  @ApiPropertyOptional({
    type: [String],
    example: ["507f1f77bcf86cd799439011"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  hotelBookingIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ["507f1f77bcf86cd799439012"],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsMongoId({ each: true })
  flightBookingIds?: string[];
}

export class ReorderItineraryDaysDto {
  @ApiProperty({
    type: [String],
    description: "All day IDs in the requested order",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsMongoId({ each: true })
  dayIds: string[];
}
