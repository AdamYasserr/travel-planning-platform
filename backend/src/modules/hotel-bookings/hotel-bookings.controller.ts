import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';

import {
  CreateHotelBookingDto,
  HotelBookingListQueryDto,
} from './dto/hotel-bookings.dto';
import { HotelBookingsService } from './hotel-bookings.service';

type AuthenticatedRequest = Request & {
  user: { userId: string };
};

@ApiTags('Hotel Bookings')
@ApiCookieAuth('access_token')
@Controller('hotel-bookings')
export class HotelBookingsController {
  constructor(private readonly hotelBookingsService: HotelBookingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a hotel booking hold' })
  create(
    @Body() dto: CreateHotelBookingDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelBookingsService.create(request.user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List the current user’s hotel bookings' })
  list(
    @Query() query: HotelBookingListQueryDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelBookingsService.listForUser(
      request.user.userId,
      query.page,
      query.limit,
      query.group,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a hotel booking' })
  get(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelBookingsService.getForUser(request.user.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel a hotel booking (unpaid hold or confirmed booking)' })
  cancelBooking(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelBookingsService.cancel(request.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Cancel a hotel booking',
    description: 'Legacy alias of POST /hotel-bookings/:id/cancel.',
  })
  cancel(
    @Param('id') id: string,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.hotelBookingsService.cancel(request.user.userId, id);
  }
}
