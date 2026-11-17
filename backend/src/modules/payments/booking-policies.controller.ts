import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { BookingPoliciesService } from './booking-policies.service';
import { AcceptPoliciesDto } from './dto/payments.dto';
import { PaymentBookingType } from './enums/payment-status.enum';

type AuthenticatedRequest = Request & { user: { userId: string } };

@ApiTags('Payments')
@ApiCookieAuth('access_token')
@Controller('bookings')
export class BookingPoliciesController {
  constructor(private readonly policies: BookingPoliciesService) {}

  @Get(':type/:id/policies')
  @ApiParam({ name: 'type', enum: ['flight', 'hotel'] })
  @ApiOperation({
    summary: 'The provider policies to accept before paying',
    description:
      'Flight: cancellation tiers and baggage policy (snapshot taken when the booking was created). Hotel: cancellation tiers and check-in/check-out times. Owner only (another user\'s booking is 404).',
  })
  get(
    @Param('type', new ParseEnumPipe(PaymentBookingType)) type: PaymentBookingType,
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.policies.get(request.user.userId, type, id);
  }

  @Post(':type/:id/accept-policies')
  @HttpCode(200)
  @ApiParam({ name: 'type', enum: ['flight', 'hotel'] })
  @ApiOperation({
    summary: 'Accept the provider policies (required before payment)',
    description:
      'Body { "accepted": true }. Stores policiesAcceptedAt. Idempotent: a second call keeps the first timestamp. 409 unless the booking is Pending Payment with a valid hold.',
  })
  accept(
    @Param('type', new ParseEnumPipe(PaymentBookingType)) type: PaymentBookingType,
    @Param('id') id: string,
    @Body() _dto: AcceptPoliciesDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.policies.accept(request.user.userId, type, id);
  }
}
