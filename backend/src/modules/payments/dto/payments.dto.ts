import { IsEnum, IsMongoId } from 'class-validator';

import { PaymentBookingType } from '../enums/payment-status.enum';

export class CreateCheckoutSessionDto {
  @IsEnum(PaymentBookingType)
  bookingType: PaymentBookingType;

  @IsMongoId()
  bookingId: string;
}
