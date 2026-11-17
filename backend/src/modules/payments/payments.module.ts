
import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';

import { Payment, PaymentSchema } from './schemas/payment.schema';

import {
  HotelBooking,
  HotelBookingSchema,
} from '../hotel-bookings/schemas/hotel-booking.schema';

// FLT-23: Payments confirms flight bookings and flight bookings uses payments
// for Stripe calls, so both modules reference each other with forwardRef.
import { FlightBookingsModule } from '../flight-bookings/flight-bookings.module';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
    ]),
    forwardRef(() => FlightBookingsModule),
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
