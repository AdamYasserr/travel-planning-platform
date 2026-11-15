import {
  ArrayMinSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsMongoId,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HotelBookingRoomDto {
  @IsMongoId()
  roomId: string;

  @IsInt()
  @Min(0)
  adults: number;

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(17, { each: true })
  childrenAges?: number[];
}

export class CreateHotelBookingDto {
  @IsMongoId()
  hotelId: string;

  @IsDateString()
  checkInDate: string;

  @IsDateString()
  checkOutDate: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique((room: HotelBookingRoomDto) => room.roomId)
  @ValidateNested({ each: true })
  @Type(() => HotelBookingRoomDto)
  rooms: HotelBookingRoomDto[];

  @IsBoolean()
  @Equals(true, {
    message: 'You must accept the hotel policies before proceeding',
  })
  policiesAccepted: boolean;
}