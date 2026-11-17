import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { PaymentsService } from './payments.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@ApiTags('Payments')
@ApiCookieAuth('access_token')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get the refund for a payment',
    description:
      'The refund id equals the payment id: use the `refundId` returned by the booking cancellation response or by GET /payments/:id. Returns 404 when the payment has no refund.',
  })
  @ApiResponse({ status: 404, description: 'Payment not found, not yours, or it has no refund.' })
  getRefund(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.paymentsService.getRefundForUser(request.user.userId, id);
  }
}
