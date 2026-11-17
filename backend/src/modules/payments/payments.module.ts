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
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { Payment, PaymentSchema, StripeWebhookEvent, StripeWebhookEventSchema } from './schemas/payment.schema';
import { StripeWebhookController } from '../../integrations/stripe/stripe-webhook.controller';

@Module({
  imports: [
    StripeModule,
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: StripeWebhookEvent.name, schema: StripeWebhookEventSchema },
      { name: HotelBooking.name, schema: HotelBookingSchema },
      { name: FlightBooking.name, schema: FlightBookingSchema },
      { name: CabinInventory.name, schema: CabinInventorySchema },
    ]),
  ],
  controllers: [PaymentsController, StripeWebhookController],
  providers: [PaymentsService],
  exports: [PaymentsService, MongooseModule],
})
export class PaymentsModule {}
