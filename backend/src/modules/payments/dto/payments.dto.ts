
import { IsMongoId } from 'class-validator';

export class CreateHotelPaymentDto {
  @IsMongoId()
  bookingId: string;
}
