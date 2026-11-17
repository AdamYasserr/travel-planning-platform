import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from '../../modules/payments/payments.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@ApiTags('Payments')
// One handler, two paths: /payments/webhook (main, per the project spec) and /stripe/webhook (legacy).
@Controller(['payments', 'stripe'])
export class StripeWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('webhook')
  @Public()
  @ApiOperation({
    summary: 'Stripe webhook receiver',
    description:
      'Main path: POST /api/payments/webhook. The legacy path POST /api/stripe/webhook is a legacy alias of this route and behaves identically. The signature is verified against the raw request body.',
  })
  @ApiHeader({ name: 'stripe-signature', required: true })
  async receive(
    @Req() request: RawBodyRequest,
    @Headers('stripe-signature') signature?: string,
  ) {
    if (!request.rawBody || !signature) {
      throw new BadRequestException('Missing Stripe webhook signature or raw body');
    }
    await this.paymentsService.handleStripeWebhook(request.rawBody, signature);
    return { received: true };
  }
}
