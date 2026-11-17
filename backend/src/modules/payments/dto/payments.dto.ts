import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsMongoId, IsOptional } from 'class-validator';

import { PaymentBookingType } from '../enums/payment-status.enum';

export class CreatePaymentDto {
  @ApiProperty({ enum: ['flight', 'hotel'], example: 'hotel' })
  @IsIn(Object.values(PaymentBookingType), {
    message: 'bookingType must be exactly "flight" or "hotel"',
  })
  bookingType: PaymentBookingType;

  @ApiProperty({ example: '507f1f77bcf86cd799439011' })
  @IsMongoId()
  bookingId: string;
}

export class AcceptPoliciesDto {
  @ApiProperty({ enum: [true], example: true })
  // Read the raw value: implicit conversion would turn the string "false" into true.
  @Transform(({ obj }: { obj: { accepted?: unknown } }) => obj.accepted)
  @IsIn([true], { message: 'accepted must be the boolean true' })
  accepted: true;
}

export class TestConfirmDto {
  @ApiPropertyOptional({
    enum: ['success', 'decline'],
    description: 'success (default) pays with the Stripe test card pm_card_visa; decline uses pm_card_chargeDeclined.',
  })
  @IsOptional()
  @IsIn(['success', 'decline'])
  outcome?: 'success' | 'decline';
}
