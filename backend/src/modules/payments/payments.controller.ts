import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Req,
  BadRequestException,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CreateCheckoutSessionDto } from './dto/payments.dto';
import { PaymentsService } from './payments.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@ApiTags('Payments')
@ApiCookieAuth('access_token')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('checkout-session')
  @ApiOperation({ summary: 'Create or retrieve a booking Checkout Session' })
  createCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.paymentsService.createCheckoutSession(
      request.user.userId,
      dto,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get the current user’s payment status' })
  getStatus(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    if (!id) {
      throw new BadRequestException('Payment ID is required');
    }
    return this.paymentsService.getForUser(request.user.userId, id);
  }
}
