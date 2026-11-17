
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
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { PaymentsService } from './payments.service';
import { CreateHotelPaymentDto } from './dto/payments.dto';
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
