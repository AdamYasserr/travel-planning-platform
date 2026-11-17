import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { PaymentsService } from '../../modules/payments/payments.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('webhook')
  @Public()
  @ApiExcludeEndpoint()
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
