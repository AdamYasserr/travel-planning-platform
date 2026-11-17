
import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { PaymentsService } from './payments.service';
import {
  CreateFlightPaymentDto,
  CreateHotelPaymentDto,
} from './dto/payments.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '../../common/enums/user-role.enum';

type AuthenticatedRequest = Request & {
  user: {
    userId: string;
    role: UserRole;
  };
  rawBody?: Buffer;
};

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
  ) {}

  // PAY-01: Create a Stripe PaymentIntent for a hotel booking.
  @Post('hotel/intent')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Create a hotel payment intent' })
  createHotelPayment(
    @Body() dto: CreateHotelPaymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentsService.createHotelPayment(
      request.user.userId,
      dto.bookingId,
    );
  }

  // HTL-21 / PAY-03: Cancel a hotel booking and process its refund.
  @Post('hotel/:bookingId/cancel')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Cancel a hotel booking and process refund' })
  cancelHotelBooking(
    @Param('bookingId') bookingId: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentsService.cancelHotelBooking(
      request.user.userId,
      bookingId,
    );
  }

  // PAY-01 / FLT-23: Create (or reuse, as a retry) a Stripe PaymentIntent for
  // a flight booking. Requires Pending Payment, a live hold and accepted policies.
  @Post('flight/intent')
  @Roles(UserRole.USER)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Create a flight payment intent',
    description:
      'Creates or reuses a Stripe PaymentIntent (test mode) for your Pending Payment flight booking. Call again to retry until the 10-minute hold expires. The booking is confirmed only by the verified webhook.',
  })
  @ApiCreatedResponse({ description: '{ paymentIntentId, clientSecret, amount, currency, holdExpiresAt }' })
  @ApiNotFoundResponse({ description: 'Booking not found or not yours' })
  @ApiConflictResponse({
    description: 'Not awaiting payment, hold expired, policies not accepted, wrong currency or already paid',
  })
  createFlightPayment(
    @Body() dto: CreateFlightPaymentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentsService.createFlightPayment(
      request.user.userId,
      dto.bookingId,
    );
  }

  // PAY-01 / PAY-03: Receive Stripe webhook events.
  @Post('webhook')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Receive verified Stripe webhook events' })
  webhook(
    @Req() request: AuthenticatedRequest,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!request.rawBody || !signature) {
      throw new Error(
        'Stripe raw request body or signature is missing',
      );
    }

    return this.paymentsService.handleWebhook(
      request.rawBody,
      signature,
    );
  }
}
