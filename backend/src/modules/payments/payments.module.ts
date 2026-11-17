import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { StripeModule } from '../../integrations/stripe/stripe.module';
import {
  FlightBooking,
  FlightBookingSchema,
} from '../flight-bookings/schemas/flight-booking.schema';
import {
  HotelBooking,
  HotelBookingSchema,
} from '../hotel-bookings/schemas/hotel-booking.schema';
import {
  CabinInventory,
  CabinInventorySchema,
} from '../flights/schemas/cabin-inventory.schema';
import { ReferenceDataModule } from '../reference-data/reference-data.module';
import { BookingPoliciesController } from './booking-policies.controller';
import { BookingPoliciesService } from './booking-policies.service';
import { PaymentsController } from './payments.controller';
import { RefundsController } from './refunds.controller';
import { PaymentsService } from './payments.service';
import { Refund, RefundSchema } from './schemas/refund.schema';
import { RefundsService } from './refunds.service';
import { Payment, PaymentSchema, StripeWebhookEvent, StripeWebhookEventSchema } from './schemas/payment.schema';
import { StripeWebhookController } from '../../integrations/stripe/stripe-webhook.controller';

@Module({
  imports: [
    StripeModule,
    ReferenceDataModule,
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: StripeWebhookEvent.name, schema: StripeWebhookEventSchema },
      { name: Refund.name, schema: RefundSchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: CabinInventory.name, schema: CabinInventorySchema },
    ]),
  ],
  controllers: [PaymentsController, BookingPoliciesController, RefundsController, StripeWebhookController],
  providers: [PaymentsService, BookingPoliciesService, RefundsService],
  exports: [PaymentsService, RefundsService, MongooseModule],
})
export class PaymentsModule {}
