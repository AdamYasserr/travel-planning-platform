
import { ApiProperty } from '@nestjs/swagger';
import { IsMongoId } from 'class-validator';

export class CreateHotelPaymentDto {
  @IsMongoId()
  bookingId: string;
}

// PAY-01 / FLT-23: Create or reuse a PaymentIntent for a flight booking
export class CreateFlightPaymentDto {
  @ApiProperty({ description: 'Flight booking ID (Pending Payment, policies accepted)' })
  @IsMongoId()
  bookingId: string;
}
