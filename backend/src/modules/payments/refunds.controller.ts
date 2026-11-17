import { Controller, Get, Param, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { RefundsService } from './refunds.service';

type AuthenticatedRequest = Request & {
  user: { userId: string; role?: string };
};

@ApiTags('Payments')
@ApiCookieAuth('access_token')
@Controller('refunds')
export class RefundsController {
  constructor(private readonly refunds: RefundsService) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Get a refund (owner or admin)',
    description:
      'Use the `refundId` returned by the booking cancellation response or by GET /payments/:id. Status is Pending, Refunded or Failed (final; a failed refund needs manual handling in the Stripe dashboard).',
  })
  @ApiResponse({ status: 404, description: 'Refund not found, or not yours.' })
  getRefund(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.refunds.getForViewer(request.user, id);
  }
}
