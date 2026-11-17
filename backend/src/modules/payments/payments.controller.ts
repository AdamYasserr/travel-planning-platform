import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CreatePaymentDto, TestConfirmDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@ApiTags('Payments')
@ApiCookieAuth('access_token')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create (or get) the PaymentIntent of a Pending Payment booking',
    description:
      'PAY-01. Returns { paymentId, clientSecret, amount, currency } (plus amountMinor). The amount and currency come from the booking. ' +
      'Pass the clientSecret to Stripe Elements in the browser; card data never reaches this API. The booking is confirmed only when the signed Stripe webhook reports success. ' +
      '409 when the policies are not accepted (PAY-02), the hold expired, or the booking is not Pending Payment.',
  })
  create(@Body() dto: CreatePaymentDto, @Req() request: AuthenticatedRequest) {
    return this.paymentsService.createPayment(request.user.userId, dto);
  }

  @Post(':id/retry')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Try again after a failed payment attempt',
    description:
      'Allowed while the booking hold is valid. Reuses the same PaymentIntent when Stripe says it can still be used, otherwise creates a new one. Returns the same shape as POST /payments.',
  })
  retry(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.paymentsService.retryPayment(request.user.userId, id);
  }

  @Post(':id/test-confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'TEST MODE ONLY: pay with a Stripe test card from Swagger',
    description:
      'Confirms the PaymentIntent on the server with the Stripe test card pm_card_visa (body { "outcome": "decline" } uses pm_card_chargeDeclined to simulate a failure). ' +
      'Answers 404 unless STRIPE_SECRET_KEY starts with sk_test_ and NODE_ENV is not production. ' +
      "It does NOT confirm the booking: that happens only when Stripe's signed webhook arrives (see the README for `stripe listen`).",
  })
  testConfirm(
    @Param('id') id: string,
    @Body() dto: TestConfirmDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentsService.testConfirm(request.user.userId, id, dto.outcome);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get the current user’s payment status',
    description: 'Includes `refundId` (equal to the payment id) when a refund exists; use it with GET /refunds/:id.',
  })
  getStatus(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    if (!id) {
      throw new BadRequestException('Payment ID is required');
    }
    return this.paymentsService.getForUser(request.user.userId, id);
  }
}
